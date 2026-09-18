import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AMBIGUOUS_NATIVE_EXECUTION, AMBIGUOUS_WAKE_EXECUTION, claimedExecution, createWorkerController, disposedWakeExecution, executionClosed } from './control.js';
import { activityFixture, configFixture, executionId, receiptFixture, traceFixture } from '../test-fixtures.js';
import type { NativeHost, WorkerOptions } from './types.js';

test('completed inbox receipt cannot close a running execution or substitute for telemetry', () => {
  assert.equal(executionClosed(activityFixture(true), receiptFixture(), [traceFixture()], 'agent:writer', executionId), undefined);
  assert.equal(executionClosed(activityFixture(), receiptFixture(), [], 'agent:writer', executionId), undefined);
  assert.equal(executionClosed(activityFixture(), receiptFixture(), [traceFixture()], 'agent:writer', executionId), executionId);
  assert.throws(() => executionClosed({ ...activityFixture(), executions: undefined }, receiptFixture(), [traceFixture()], 'agent:writer', executionId), /authority/);
  assert.throws(() => executionClosed(activityFixture(), { ...receiptFixture(), execution_id: 'foreign' }, [traceFixture()], 'agent:writer', executionId), /identity/);
  assert.throws(() => executionClosed(activityFixture(), { ...receiptFixture(), agent_id: 'other' }, [traceFixture()], 'agent:writer', executionId), /identity/);
});

/**
 * The property the single-trace rule was standing in for. A trial whose subject
 * deferred runs its continuations as further wakes, so three closed traces is its
 * own history and not three competing answers: the frame names one and that one
 * resolves. What may never resolve is anything foreign, or a name two traces
 * answer to — and neither is decided by how many traces there are.
 */
test('a named execution resolves out of a continued trial\'s own closed wakes', () => {
  const earlier = { ...traceFixture(), turn_id: 'earlier-execution' };
  const middle = { ...traceFixture(), turn_id: 'middle-execution' };
  assert.equal(executionClosed(activityFixture(), receiptFixture(), [earlier, middle, traceFixture()], 'agent:writer', executionId), executionId);
  // A name nothing answers to resolves to nothing, never to a neighbour by position.
  assert.equal(executionClosed(activityFixture(), receiptFixture(), [earlier, middle], 'agent:writer', executionId), undefined);
  // Another agent's execution among this trial's own is refused whatever the arity.
  assert.throws(() => executionClosed(activityFixture(), receiptFixture(), [{ ...earlier, agent_id: 'other' }, traceFixture()], 'agent:writer', executionId), /identity/);
  // And two traces answering to the named execution resolve to neither of them.
  assert.throws(() => executionClosed(activityFixture(), receiptFixture(), [earlier, traceFixture(), traceFixture()], 'agent:writer', executionId),
    new RegExp(AMBIGUOUS_NATIVE_EXECUTION, 'u'));
  // A still-running runtime outranks any of it: nothing resolves while it spends.
  assert.equal(executionClosed(activityFixture(true), receiptFixture(), [earlier, traceFixture()], 'agent:writer', executionId), undefined);
});

/**
 * Which execution answers for a delivery is the runtime's own statement, and it
 * has two forms because Daimon writes them at different moments: the receipt
 * carries the execution while the wake runs and keeps it on a completed
 * delivery, and the projection names the deliveries an admitted execution
 * covers — the only authority left once a deferral has cleared the receipt's.
 */
test('a delivery is bound to the execution the runtime names for it, not to a neighbour', () => {
  const receipt = receiptFixture();
  assert.equal(claimedExecution(receipt, activityFixture(), 'trial:wake', 'agent:writer'), executionId);
  // Cleared by the subject's deferral: the live projection still says whose it is.
  const deferred = { ...receipt, state: 'accepted' as const, deferred: true, execution_id: undefined };
  assert.equal(claimedExecution(deferred, activityFixture(true), 'trial:wake', 'agent:writer'), executionId);
  // An execution running for ANOTHER delivery of this trial is not this one's, and
  // that is the whole of the live defect: a continuation was handed the execution
  // the runtime had opened to revisit the trial's own deferred assignment.
  const elsewhere = { ...activityFixture(true), executions: [{ ...activityFixture(true).executions![0]!, delivery_ids: ['trial:task'] }] };
  assert.equal(claimedExecution(deferred, elsewhere, 'trial:answer', 'agent:writer'), undefined);
  assert.equal(claimedExecution({ ...deferred, agent_id: 'other' }, { ...activityFixture(), executions: [] }, 'trial:wake', 'agent:writer'), undefined);
  assert.equal(claimedExecution(deferred, { ...activityFixture(), executions: undefined }, 'trial:wake', 'agent:writer'), undefined);
});

/**
 * And when it names none, the question may only be asked of a delivery it has
 * already disposed of, on a runtime admitting nothing — and answered by what
 * closed inside this wake's own window.
 */
test('an undisposed delivery answers for nothing, and two unattributed executions refuse', () => {
  const history = new Set<string>(['earlier-execution']);
  const traces = [{ ...traceFixture(), turn_id: 'earlier-execution' }, traceFixture()];
  // Still queued: the runtime has said nothing about this delivery, and the trace
  // that just closed belongs to whatever the runtime was doing meanwhile.
  assert.equal(disposedWakeExecution({ ...receiptFixture(), state: 'accepted' }, traces, history), undefined);
  assert.equal(disposedWakeExecution(receiptFixture(), traces, history), executionId);
  assert.equal(disposedWakeExecution({ ...receiptFixture(), state: 'accepted', deferred: true }, traces, history), executionId);
  assert.equal(disposedWakeExecution(receiptFixture(), [traces[0]!], history), undefined);
  // Two executions closed inside one delivery's window and nothing says which is
  // its own: it fails closed under its own name rather than taking the first.
  assert.throws(() => disposedWakeExecution(receiptFixture(), [...traces, { ...traceFixture(), turn_id: 'another-execution' }], history),
    new RegExp(AMBIGUOUS_WAKE_EXECUTION, 'u'));
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
      await writeFile(join(root, 'control/usage.jsonl'), `${JSON.stringify({ v: 'noopolis.daimon.turn-usage.v1', agent: 'agent:writer',
        wake: executionId, engine: 'codex', at: '2026-09-13T00:00:01.000Z', input: 1, output: 1, cache_read: 0, total: 2, complete: true })}\n`);
      await writeFile(join(root, 'runtime/.codex/sessions/2026/09/13/rollout-unit.jsonl'), `${JSON.stringify({ type: 'turn_context', payload: { model: 'test-model-v1' } })}\n`);
      // Closed telemetry is the fixture's publication barrier: all evidence exists first.
      await writeFile(join(root, 'runtime', 'telemetry/turns.ndjson'), `${JSON.stringify(traceFixture())}\n`);
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
    assert.equal(result.coverage.find(row => row.channel === 'usage')?.completeness, 'complete');
    assert.equal(result.native.modelContexts.length, 1);
  } finally { await publishing; await rm(root, { recursive: true, force: true }); }
});
