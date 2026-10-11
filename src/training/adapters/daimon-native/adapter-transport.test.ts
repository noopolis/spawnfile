import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createDaimonNativeAdapter } from './adapter.js';
import { dockerFixture, launchFixture } from './test-fixtures.js';
import type { DockerCommand } from './container/index.js';
import type { Observation } from '../../contracts/execution.js';
import type { TerminalEvidence, TransportDeliverySource } from './worker/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const first = { kind: 'transport', deliveryIdPrefix: 'moltnet:' } as const;
const reply = { kind: 'transport', deliveryId: 'moltnet:reply' } as const;
const text = 'Research answer';
const provenance = { kind: 'transport', id: 'reply', sha256: `sha256:${createHash('sha256').update(text).digest('hex')}` };

async function transportFixture(deferred = false) {
  const fixture = await launchFixture(); roots.push(fixture.root);
  fixture.launch.delivery = 'transport'; await fixture.save();
  const docker = dockerFixture(fixture.launch, fixture.input.trialId);
  const requests: { wakeId: string; text: string; source: TransportDeliverySource; controls?: unknown }[] = [];
  const events: Observation[] = []; fixture.input.onObservation = event => { events.push(event); };
  let armedReads = 0;
  let resolve!: (value: unknown) => void;
  const run: DockerCommand = async (args, options) => {
    const input = JSON.parse(options?.stdin ?? '{}') as { path?: string; body?: typeof requests[number] };
    if (args[0] !== 'exec' || input.path !== '/trial/run') return docker.run(args, options);
    if (input.body) {
      requests.push(input.body);
      return { code: 0, stdout: JSON.stringify(await new Promise(done => { resolve = done; })), stderr: '' };
    }
    armedReads++;
    const current = requests[requests.length - 1]!;
    return { code: 0, stdout: JSON.stringify({ state: 'waiting', wakeId: current.wakeId, source: current.source }), stderr: '' };
  };
  const publish = vi.fn(async () => {
    expect(armedReads).toBe(requests.length);
    const current = requests[requests.length - 1]!;
    const deliveryId = current.source.deliveryId ?? 'moltnet:assignment';
    const executionId = `execution-${requests.length}`;
    resolve({ schema: 'paideia.daimon-native.trial.v1', trialId: fixture.input.trialId, wakeId: current.wakeId,
      agentId: fixture.launch.agent.id, model: fixture.launch.agent.model, configSha256: fixture.launch.configSha256,
      status: deferred && requests.length === 1 ? 'failed' : 'completed',
      ...(deferred && requests.length === 1 ? { blocked: 'awaiting-external-input' } : {}),
      receipt: { agent_id: fixture.launch.agent.id, delivery_id: deliveryId, acceptance_id: `accepted-${requests.length}` }, executionId,
      transport: { source: current.source, deliveryId, acceptanceId: `accepted-${requests.length}`,
        batch: { executionId, deliveryIds: [deliveryId, 'moltnet:second-batch-member'], observedAt: new Date().toISOString() },
        deliveries: [], deferredDeliveryIds: [], renderedAllowances: 'unavailable-public-api' },
      completedAt: new Date().toISOString(), native: { traces: [], toolReceipts: [], modelContexts: [],
        usage: [{ wake: executionId, engine: 'codex', input: 100, output: 20, cache_read: 40 }] }, coverage: [] } as unknown as TerminalEvidence);
  });
  return { ...fixture, docker, run, publish, requests, events, finish: (value: unknown) => resolve(value) };
}

it('requires an explicit initial transport provider before starting a worker', async () => {
  const fixture = await transportFixture();
  await expect(createDaimonNativeAdapter({ docker: fixture.run }).start(fixture.input)).rejects.toThrow('requires a transport delivery provider');
  expect(fixture.docker.calls).toHaveLength(0);
  expect(() => createDaimonNativeAdapter({ transportDelivery: {} as never })).toThrow('Invalid transport delivery provider');
});

it('arms the initial delivery then its exact sourced continuation before either provider publishes', async () => {
  const fixture = await transportFixture(true);
  const prepare = vi.fn(async (context: { trialId: string; turnId: string; text: string }) => {
    expect(context).toMatchObject({ trialId: fixture.input.trialId, turnId: 'task', text: 'Assignment' });
    return { source: first, publish: fixture.publish };
  });
  const next = vi.fn(async () => ({ id: 'answer', text, source: provenance, transport: { source: reply, publish: fixture.publish } }));
  const session = await createDaimonNativeAdapter({ docker: fixture.run, timeoutMs: 5000,
    transportDelivery: { prepare }, externalInputs: { maxDeliveries: 1, next } }).start(fixture.input);
  const result = await session.run({ id: 'task', text: 'Assignment' });
  expect(result.status).toBe('completed'); expect(result.usage?.inputTokens).toBe(200);
  expect(prepare).toHaveBeenCalledOnce(); expect(next).toHaveBeenCalledOnce(); expect(fixture.publish).toHaveBeenCalledTimes(2);
  expect(fixture.requests).toEqual([
    { wakeId: 'task', text: 'Assignment', source: first, controls: { maxExternalDeliveries: 1 } },
    { wakeId: 'answer', text, source: reply, controls: { source: provenance } },
  ]);
  const terminals = fixture.events.filter(event => event.type === 'diagnostic');
  expect(terminals).toHaveLength(2);
  expect(terminals[0]?.native).toMatchObject({ transport: { deliveryId: 'moltnet:assignment',
    batch: { deliveryIds: ['moltnet:assignment', 'moltnet:second-batch-member'] } } });
  expect((await session.stop('Verified fixture')).quiescence).toBe('confirmed');
});

it.each(['missing', 'prefix'] as const)('refuses a %s transport continuation before arming its wake', async bad => {
  const fixture = await transportFixture(true);
  const next = async () => ({ id: 'answer', text, source: provenance,
    ...(bad === 'prefix' ? { transport: { source: first, publish: fixture.publish } } : {}) });
  const session = await createDaimonNativeAdapter({ docker: fixture.run, timeoutMs: 5000,
    transportDelivery: { prepare: async () => ({ source: first, publish: fixture.publish }) }, externalInputs: { maxDeliveries: 1, next } }).start(fixture.input);
  const result = await session.run({ id: 'task', text: 'Assignment' });
  expect(result.status).toBe('failed'); expect(result.error).toMatch(/Transport continuation requires/);
  expect(fixture.requests).toHaveLength(1); expect(fixture.publish).toHaveBeenCalledOnce();
});

it('refuses terminal evidence whose transport receipt belongs to a different delivery', async () => {
  const fixture = await transportFixture();
  const session = await createDaimonNativeAdapter({ docker: fixture.run, timeoutMs: 5000,
    transportDelivery: { prepare: async () => ({ source: first, publish: async () => {
      fixture.finish({ schema: 'paideia.daimon-native.trial.v1', trialId: fixture.input.trialId, wakeId: 'task',
        agentId: fixture.launch.agent.id, model: fixture.launch.agent.model, configSha256: fixture.launch.configSha256,
        transport: { source: first, deliveryId: 'moltnet:real', acceptanceId: 'accepted' },
        receipt: { delivery_id: 'trial:task', acceptance_id: 'accepted' } });
    } }) } }).start(fixture.input);
  const result = await session.run({ id: 'task', text: 'Assignment' });
  expect(result.status).toBe('failed'); expect(result.error).toContain('transport terminal evidence identity mismatch');
  expect(result.stop?.quiescence).toBe('confirmed');
});

it('bounds preparation to the shared trial deadline without starting a run', async () => {
  const fixture = await transportFixture();
  let observed: AbortSignal | undefined;
  const session = await createDaimonNativeAdapter({ docker: fixture.run, timeoutMs: 100,
    transportDelivery: { prepare: async (_context, signal) => { observed = signal; return new Promise(() => undefined); } } }).start(fixture.input);
  const result = await session.run({ id: 'task', text: 'Assignment' });
  expect(result.status).toBe('failed'); expect(result.error).toContain('deadline exceeded awaiting transport delivery');
  expect(observed?.aborted).toBe(true); expect(fixture.requests).toHaveLength(0);
});

it.each(['absent-delivery', 'missed-batch'] as const)('preserves %s failure evidence and its clear original error', async kind => {
  const fixture = await transportFixture();
  const error = kind === 'absent-delivery' ? 'Transport delivery did not arrive before deadline' : 'Transport execution closed without observable batch membership';
  const next = vi.fn(async () => null);
  const session = await createDaimonNativeAdapter({ docker: fixture.run, timeoutMs: 5000, externalInputs: { maxDeliveries: 1, next },
    transportDelivery: { prepare: async () => ({ source: first, publish: async () => {
      fixture.finish({ schema: 'paideia.daimon-native.trial.v1', trialId: fixture.input.trialId, wakeId: 'task',
        agentId: fixture.launch.agent.id, model: fixture.launch.agent.model, configSha256: fixture.launch.configSha256,
        status: 'failed', error, completedAt: new Date().toISOString(), native: { usage: [], traces: [], modelContexts: [], toolReceipts: [] }, coverage: [],
        transport: { source: first, ...(kind === 'missed-batch' ? { deliveryId: 'moltnet:real', acceptanceId: 'accepted' } : {}) },
        ...(kind === 'missed-batch' ? { executionId: 'execution', receipt: {
          agent_id: fixture.launch.agent.id, delivery_id: 'moltnet:real', acceptance_id: 'accepted' } } : {}) });
    } }) } }).start(fixture.input);
  const result = await session.run({ id: 'task', text: 'Assignment' });
  expect(result.status).toBe('failed'); expect(result.error).toBe(error); expect(next).not.toHaveBeenCalled();
  expect(fixture.events.find(event => event.type === 'diagnostic')?.native).toMatchObject({ status: 'failed', error });
  await session.stop('Observed explicit transport failure');
});
