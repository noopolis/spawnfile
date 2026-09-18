import { expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createDaimonNativeAdapter } from './adapter.js';
import { dockerFixture, launchFixture } from './test-fixtures.js';
import type { Observation } from '../../contracts/execution.js';

test('adapter resumes only sourced deferred work and captures all usage once with external input provenance', async () => {
  const fixture = await launchFixture();
  try {
    const docker = dockerFixture(fixture.launch, fixture.input.trialId);
    const events: Observation[] = [];
    fixture.input.onObservation = event => { events.push(event); };
    const terminal = { schema: 'paideia.daimon-native.trial.v1', trialId: fixture.input.trialId, wakeId: 'task',
      agentId: 'agent:writer', model: 'test-model-v1', configSha256: fixture.launch.configSha256, status: 'failed', blocked: 'awaiting-external-input',
      completedAt: new Date().toISOString(), native: { traces: [], toolReceipts: [], modelContexts: [], usage: [{ input: 100, output: 20, cache_read: 40 }] },
      coverage: [{ channel: 'output', completeness: 'absent', ordering: 'none' }, { channel: 'usage', completeness: 'partial', ordering: 'source' }] };
    docker.setTerminal(terminal);
    const text = 'Verified response';
    const next = vi.fn(async () => {
      docker.setTerminal({ ...terminal, wakeId: 'answer', status: 'completed', blocked: undefined,
        coverage: [{ channel: 'usage', completeness: 'complete', ordering: 'source' }] });
      return { id: 'answer', text, source: { kind: 'transport', id: 'answer', sha256: `sha256:${createHash('sha256').update(text).digest('hex')}` } };
    });
    const session = await createDaimonNativeAdapter({ docker: docker.run, timeoutMs: 1000,
      externalInputs: { maxDeliveries: 1, next } }).start(fixture.input);
    const result = await session.run({ id: 'task', text: 'Assigned article' });
    expect(result.status).toBe('completed');
    expect(result.usage?.inputTokens).toBe(200);
    expect(result.coverage?.find(item => item.channel === 'usage')?.completeness).toBe('partial');
    expect(next).toHaveBeenCalledOnce();
    expect(events.filter(event => event.type === 'input')).toHaveLength(1);
    expect(events.every(event => event.wakeId === 'task')).toBe(true);
    expect(events.filter(event => event.type === 'tool.dispatch')).toHaveLength(0);
    expect((await session.stop('Done')).quiescence).toBe('confirmed');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('a stop that races a verified deferred wake reports cancellation without the blocked receipt', async () => {
  const fixture = await launchFixture();
  try {
    const docker = dockerFixture(fixture.launch, fixture.input.trialId);
    docker.setTerminal({ schema: 'paideia.daimon-native.trial.v1', trialId: fixture.input.trialId, wakeId: 'task',
      agentId: 'agent:writer', model: 'test-model-v1', configSha256: fixture.launch.configSha256, status: 'failed',
      blocked: 'awaiting-external-input', completedAt: new Date().toISOString(),
      native: { traces: [], toolReceipts: [], modelContexts: [], usage: [{ input: 100, output: 20, cache_read: 40 }] },
      coverage: [{ channel: 'usage', completeness: 'partial', ordering: 'source' }] });
    const opened: { session?: Awaited<ReturnType<ReturnType<typeof createDaimonNativeAdapter>['start']>> } = {};
    // Stopping while the verified terminal evidence is being published makes the turn
    // the machine's outcome; the deferral it carried must not survive that.
    fixture.input.onObservation = event => { if (event.type === 'usage') void opened.session!.stop('Operator stopped'); };
    opened.session = await createDaimonNativeAdapter({ docker: docker.run, timeoutMs: 2000 }).start(fixture.input);
    const result = await opened.session.run({ id: 'task', text: 'Assigned article' });
    expect(result.status).toBe('cancelled');
    expect(result.blocked).toBeUndefined();
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('invalid external policies fail before container creation', () => {
  for (const maximum of [0, 4, 0.1]) expect(() => createDaimonNativeAdapter({ externalInputs: { maxDeliveries: maximum, next: async () => null } })).toThrow('Invalid external');
});

for (const mode of ['absent', 'duplicate', 'failure', 'cancelled'] as const) test(`continuation ${mode} stays unsuccessful with preserved usage and bounded cleanup`, async () => {
  const fixture = await launchFixture();
  try {
    const docker = dockerFixture(fixture.launch, fixture.input.trialId);
    docker.setTerminal({ schema: 'paideia.daimon-native.trial.v1', trialId: fixture.input.trialId, wakeId: 'task',
      agentId: 'agent:writer', model: 'test-model-v1', configSha256: fixture.launch.configSha256, status: 'failed', blocked: 'awaiting-external-input',
      completedAt: new Date().toISOString(), native: { traces: [], toolReceipts: [], modelContexts: [], usage: [{ input: 100, output: 20, cache_read: 40 }] },
      coverage: [{ channel: 'usage', completeness: 'partial', ordering: 'source' },
        { channel: 'output', completeness: 'absent', ordering: 'none' }, { channel: 'tools', completeness: 'partial', ordering: 'source' }] });
    const controller = new AbortController();
    const session = await createDaimonNativeAdapter({ docker: docker.run, timeoutMs: 2000, externalInputs: { maxDeliveries: 1,
      async next() {
        if (mode === 'absent') return null;
        if (mode === 'failure') throw new Error('Research unavailable');
        if (mode === 'cancelled') { controller.abort(); return null; }
        const text = 'Answer';
        return { id: 'task', text, source: { kind: 'transport', id: 'reply', sha256: `sha256:${createHash('sha256').update(text).digest('hex')}` } };
      } } }).start(fixture.input);
    const result = await session.run({ id: 'task', text: 'Task' }, controller.signal);
    expect(result.status).toBe(mode === 'cancelled' ? 'cancelled' : 'failed');
    // Only an unanswered delivery over a verified closed execution keeps the blocked
    // receipt; a broken continuation or a cancellation is the machine's own outcome.
    expect(result.blocked).toBe(mode === 'absent' ? 'awaiting-external-input' : undefined);
    expect(result.usage?.inputTokens).toBe(100);
    expect(result.coverage).toEqual([
      { channel: 'usage', completeness: 'partial', ordering: 'source' },
      { channel: 'output', completeness: 'absent', ordering: 'none' },
      { channel: 'tools', completeness: 'partial', ordering: 'source' },
    ]);
    expect(result.stop?.quiescence).toBe('confirmed');
    expect((await session.stop('Finish')).quiescence).toBe('confirmed');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

for (const defect of ['identity', 'observer'] as const) test(`never releases external input after ${defect} verification failure`, async () => {
  const fixture = await launchFixture();
  try {
    const docker = dockerFixture(fixture.launch, fixture.input.trialId);
    docker.setTerminal({ schema: 'paideia.daimon-native.trial.v1', trialId: fixture.input.trialId,
      wakeId: defect === 'identity' ? 'wrong' : 'task', agentId: 'agent:writer', model: 'test-model-v1',
      configSha256: fixture.launch.configSha256, status: 'failed', blocked: 'awaiting-external-input',
      completedAt: new Date().toISOString(), native: { traces: [], toolReceipts: [], modelContexts: [], usage: [] }, coverage: [] });
    if (defect === 'observer') fixture.input.onObservation = () => { throw new Error('Persistence failed'); };
    const next = vi.fn(async () => null);
    const session = await createDaimonNativeAdapter({ docker: docker.run, timeoutMs: 1000,
      externalInputs: { maxDeliveries: 1, next } }).start(fixture.input);
    const result = await session.run({ id: 'task', text: 'Assigned task' });
    expect(result.status).toBe('failed'); expect(result.stop?.quiescence).toBe('confirmed');
    expect(next).not.toHaveBeenCalled();
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});


test('three sourced deliveries exhaust the budget as failed with confirmed cleanup', async () => {
  const fixture = await launchFixture();
  try {
    const docker = dockerFixture(fixture.launch, fixture.input.trialId);
    const terminal = { schema: 'paideia.daimon-native.trial.v1', trialId: fixture.input.trialId, wakeId: 'task',
      agentId: 'agent:writer', model: 'test-model-v1', configSha256: fixture.launch.configSha256,
      status: 'failed', blocked: 'awaiting-external-input', completedAt: new Date().toISOString(),
      native: { traces: [], toolReceipts: [], modelContexts: [], usage: [] }, coverage: [] };
    docker.setTerminal(terminal);
    let deliveries = 0;
    const session = await createDaimonNativeAdapter({ docker: docker.run, timeoutMs: 1000, externalInputs: { maxDeliveries: 3,
      async next() { const id = `answer-${++deliveries}`; const text = 'Sourced response';
        docker.setTerminal({ ...terminal, wakeId: id });
        return { id, text, source: { id, kind: 'transport', sha256: `sha256:${createHash('sha256').update(text).digest('hex')}` } };
      } } }).start(fixture.input);
    const result = await session.run({ id: 'task', text: 'Task' });
    expect(deliveries).toBe(3); expect(result.status).toBe('failed'); expect(result.stop?.quiescence).toBe('confirmed');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});


for (const enabled of [false, true]) test(`contradictory blocked completion is rejected before external delivery (${enabled})`, async () => {
  const fixture = await launchFixture();
  try {
    const docker = dockerFixture(fixture.launch, fixture.input.trialId);
    docker.setTerminal({ schema: 'paideia.daimon-native.trial.v1', trialId: fixture.input.trialId, wakeId: 'task',
      agentId: 'agent:writer', model: 'test-model-v1', configSha256: fixture.launch.configSha256,
      status: 'completed', blocked: 'awaiting-external-input', completedAt: new Date().toISOString(),
      native: { traces: [], toolReceipts: [], modelContexts: [], usage: [] }, coverage: [] });
    const next = vi.fn(async () => null);
    const session = await createDaimonNativeAdapter({ docker: docker.run, timeoutMs: 1000,
      ...(enabled ? { externalInputs: { maxDeliveries: 3, next } } : {}) }).start(fixture.input);
    const result = await session.run({ id: 'task', text: 'Task' });
    expect(result.status).toBe('failed'); expect(result.error).toContain('cannot claim completion');
    expect(result.stop?.quiescence).toBe('confirmed'); expect(next).not.toHaveBeenCalled();
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('a raised wake budget buys no extra wall clock: the shared deadline ends a deferring subject mid-budget', async () => {
  const fixture = await launchFixture();
  try {
    const docker = dockerFixture(fixture.launch, fixture.input.trialId);
    const terminal = { schema: 'paideia.daimon-native.trial.v1', trialId: fixture.input.trialId, wakeId: 'task',
      agentId: 'agent:writer', model: 'test-model-v1', configSha256: fixture.launch.configSha256,
      status: 'failed', blocked: 'awaiting-external-input', completedAt: new Date().toISOString(),
      native: { traces: [], toolReceipts: [], modelContexts: [], usage: [] }, coverage: [] };
    docker.setTerminal(terminal);
    let deliveries = 0;
    const session = await createDaimonNativeAdapter({ docker: docker.run, timeoutMs: 400, externalInputs: { maxDeliveries: 3,
      async next() { const id = `answer-${++deliveries}`; const text = 'Sourced response';
        await new Promise(resolve => setTimeout(resolve, 250));
        docker.setTerminal({ ...terminal, wakeId: id });
        return { id, text, source: { id, kind: 'transport', sha256: `sha256:${createHash('sha256').update(text).digest('hex')}` } };
      } } }).start(fixture.input);
    const started = Date.now();
    const result = await session.run({ id: 'task', text: 'Task' });
    // The budget still had deliveries left; the one trial deadline ended it anyway.
    expect(result.status).toBe('failed');
    expect(result.error).toContain('deadline');
    expect(deliveries).toBeLessThan(3);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.stop?.quiescence).toBe('confirmed');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
