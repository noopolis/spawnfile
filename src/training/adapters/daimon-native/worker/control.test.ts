import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkerController, executionClosed } from './control.js';
import { activityFixture, configFixture, executionId, receiptFixture, traceFixture } from '../test-fixtures.js';
import type { NativeHost, WorkerOptions } from './types.js';

test('completed inbox receipt cannot close a running execution or substitute for telemetry', () => {
  assert.equal(executionClosed(activityFixture(true), receiptFixture(), [traceFixture()], 'agent:writer'), undefined);
  assert.equal(executionClosed(activityFixture(), receiptFixture(), [], 'agent:writer'), undefined);
  assert.equal(executionClosed(activityFixture(), receiptFixture(), [traceFixture()], 'agent:writer'), executionId);
  assert.throws(() => executionClosed({ ...activityFixture(), executions: undefined }, receiptFixture(), [traceFixture()], 'agent:writer'), /authority/);
  assert.throws(() => executionClosed(activityFixture(), { ...receiptFixture(), execution_id: 'foreign' }, [traceFixture()], 'agent:writer'), /identity/);
});

test('controller uses the public v2 acceptance request and persists refusal without fabricating success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-control-unit-'));
  try {
    await mkdir(join(root, 'control'));
    let request: { event: { version: string }; agent_id: string; delivery_id: string } | undefined;
    let stopped = 0;
    const host = { accept: async (value: unknown) => { request = value as typeof request; return { state: 'rejected', code: 'invalid_request' }; },
      stop: async () => { stopped++; return { version: 'noopolis.daimon.organization-runtime-stop.v1', state: 'stopped' }; } } as unknown as NativeHost;
    const options: WorkerOptions = { launch: '/launch', config: '/config.json', configSha256: 'a'.repeat(64), controlRoot: join(root, 'control'),
      tokenFile: '/token', evidence: join(root, 'control/evidence.json'), trialId: 'trial', timeoutMs: 1000, scheduleOverride: 'disabled' };
    const controller = createWorkerController(host, configFixture(root), options, 'unit-token');
    const result = await controller.run('wake', 'Read the assigned brief');
    assert.equal(request?.event.version, 'noopolis.daimon.wake.v2');
    assert.equal(request?.agent_id, 'agent:writer');
    assert.equal(request?.delivery_id, 'trial:wake');
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.native.toolReceipts, []);
    assert.equal(stopped, 1);
    assert.equal(JSON.parse(await readFile(options.evidence, 'utf8')).status, 'failed');
    await assert.rejects(controller.run('another', 'No second wake'), /exactly one/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a hanging acceptance is bounded and records missing usage as absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-deadline-unit-'));
  try {
    await mkdir(join(root, 'control'));
    const host = { accept: () => new Promise(() => {}), stop: async () => ({ state: 'stopped' }) } as unknown as NativeHost;
    const options: WorkerOptions = { launch: '/launch', config: '/config.json', configSha256: 'a'.repeat(64), controlRoot: join(root, 'control'),
      tokenFile: '/token', evidence: join(root, 'control/evidence.json'), trialId: 'trial', timeoutMs: 20, scheduleOverride: 'disabled' };
    const result = await createWorkerController(host, configFixture(root), options, 'unit-token').run('wake', 'Bound this request');
    assert.equal(result.status, 'failed');
    assert.match(result.error!, /deadline/);
    assert.equal(result.coverage.find(row => row.channel === 'usage')?.completeness, 'absent');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a paused budget and stale receipt cannot outrun a just-admitted execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-poll-race-unit-'));
  let publishing: Promise<void> | undefined;
  try {
    await mkdir(join(root, 'control'));
    await mkdir(join(root, 'runtime', 'telemetry'), { recursive: true });
    await mkdir(join(root, 'runtime', '.codex/sessions/2026/09/13'), { recursive: true });
    let receiptReads = 0;
    let publish!: () => void;
    const released = new Promise<void>(resolve => { publish = resolve; });
    publishing = released.then(async () => {
      await writeFile(join(root, 'runtime', 'telemetry/turns.ndjson'), `${JSON.stringify(traceFixture())}\n`);
      await writeFile(join(root, 'control/usage.jsonl'), `${JSON.stringify({ v: 'noopolis.daimon.turn-usage.v1', agent: 'agent:writer',
        wake: executionId, engine: 'codex', at: '2026-09-13T00:00:01.000Z', input: 1, output: 1, cache_read: 0, total: 2, complete: true })}\n`);
      await writeFile(join(root, 'runtime/.codex/sessions/2026/09/13/rollout-unit.jsonl'), `${JSON.stringify({ type: 'turn_context', payload: { model: 'test-model-v1' } })}\n`);
    });
    const host = {
      accept: async () => ({ state: 'accepted', acceptance_id: receiptFixture().acceptance_id }),
      wakeReceipt: async () => ({ ...receiptFixture(), state: ++receiptReads < 3 ? 'accepted' : 'completed' }),
      activityV2: async () => activityFixture(),
      availability: async () => { setTimeout(publish, 20); return { state: 'paused', agents: [{ agent_id: 'agent:writer' }] }; },
      stop: async () => ({ state: 'stopped' }),
    } as unknown as NativeHost;
    const options: WorkerOptions = { launch: '/launch', config: '/config.json', configSha256: 'a'.repeat(64), controlRoot: join(root, 'control'),
      tokenFile: '/token', evidence: join(root, 'control/evidence.json'), trialId: 'trial', timeoutMs: 1000, scheduleOverride: 'disabled' };
    const result = await createWorkerController(host, configFixture(root), options, 'unit-token').run('wake', 'Assigned work');
    assert.equal(result.status, 'completed', result.error);
    assert.ok(receiptReads >= 3, 'Closure rereads the durable receipt after terminal telemetry');
    assert.equal(result.receipt?.state, 'completed');
    assert.equal(result.native.usage[0]?.total, 2);
  } finally { await publishing; await rm(root, { recursive: true, force: true }); }
});
