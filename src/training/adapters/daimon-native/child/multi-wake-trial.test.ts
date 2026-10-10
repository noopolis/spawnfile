import { expect, test, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childFixture } from './fixture.js';
import { startOwnedChild } from './lifecycle.js';
import { configFixture, launchFixture } from '../test-fixtures.js';
import { createNativeObserver } from '../observations.js';
import { sumNativeUsage } from '../external.js';
import type { Usage, Observation } from '../../../contracts/execution.js';
import { createWorkerController } from '../worker/index.js';
import type { NativeHost, NativeReceipt, TerminalEvidence, WorkerOptions } from '../worker/index.js';

vi.mock('./sandbox.js', () => ({ verifyChildSandbox: vi.fn(async () => undefined) }));

/**
 * Daimon's dispatcher as this trial can observe it, including the one behaviour
 * every single-wake assumption here was built without.
 *
 * A new delivery bumps the agent's generation, which makes `selectBatch` treat
 * the trial's still-deferred deliveries as eligible again — and they sort first.
 * So a continuation does not run next: the runtime RE-EXECUTES the earlier
 * deferred delivery, closes a second execution for it, files a second trace, and
 * only then runs the continuation. A continued trial therefore closes more
 * executions than it made deliveries, all of them its own, and the projection's
 * `delivery_ids` is the only thing that says which delivery each one answers for.
 *
 * The receipt follows Daimon exactly: it carries the execution while the wake
 * runs, keeps it when the delivery completes, and has it CLEARED the moment the
 * subject defers — the one path where the projection is the only authority left.
 */
function daimonFixture(root: string, trialId: string, agentId: string, defers: (wakeId: string) => boolean) {
  const receipts = new Map<string, NativeReceipt>();
  const byDelivery = new Map<string, string>();
  const deferred: string[] = [];
  const queue: string[] = [];
  const closed: { executionId: string; deliveryId: string }[] = [];
  let running: { executionId: string; deliveryId: string } | undefined;
  let clock = 0;
  const at = (): string => new Date(Date.UTC(2026, 8, 19, 0, 0, ++clock)).toISOString();
  const receiptOf = (deliveryId: string): NativeReceipt => receipts.get(byDelivery.get(deliveryId)!)!;
  const start = (deliveryId: string): void => {
    const executionId = randomUUID();
    Object.assign(receiptOf(deliveryId), { state: 'running', execution_id: executionId, updated_at: at() });
    running = { executionId, deliveryId };
  };
  const close = async (): Promise<void> => {
    const { executionId, deliveryId } = running!;
    const wakeId = deliveryId.slice(trialId.length + 1);
    await appendFile(join(root, 'runtime/telemetry/turns.ndjson'), `${JSON.stringify({ schema: 'daimon.turn_trace.v1',
      agent_id: agentId, turn_id: executionId, started_at: at(), completed_at: at(), status: 'completed', tools: [] })}\n`);
    await appendFile(join(root, 'control/usage.jsonl'), `${JSON.stringify({ v: 'noopolis.daimon.turn-usage.v1', agent: agentId,
      wake: executionId, engine: 'codex', at: at(), input: 10 * (closed.length + 1), output: 2, cache_read: 0,
      total: 10 * (closed.length + 1) + 2, complete: true })}\n`);
    const receipt = receiptOf(deliveryId);
    if (defers(wakeId)) {
      // The subject's own disposition, written by the inbox tool DURING the turn:
      // Daimon clears the execution id with it, so nothing on this receipt will
      // ever name the execution this delivery just closed.
      Object.assign(receipt, { state: 'accepted', deferred: true, updated_at: at() });
      delete receipt.execution_id;
      if (!deferred.includes(deliveryId)) deferred.push(deliveryId);
    } else {
      Object.assign(receipt, { state: 'completed', deferred: false, updated_at: at() });
      const index = deferred.indexOf(deliveryId);
      if (index >= 0) deferred.splice(index, 1);
    }
    closed.push(running!);
    running = undefined;
  };
  // One dispatcher step per projection read: it closes the execution it was
  // running and starts the next one back to back, exactly as `drain` loops, so a
  // poller can observe the idle runtime only once the whole drain is done.
  const tick = async (): Promise<void> => {
    if (running) await close();
    const next = queue.shift();
    if (next) start(next);
  };
  const host = {
    async accept(request: { delivery_id: string; agent_id: string }) {
      const acceptance_id = randomUUID();
      receipts.set(acceptance_id, { version: 'noopolis.daimon.wake-receipt-status.v2', acceptance_id, agent_id: request.agent_id,
        delivery_id: request.delivery_id, request_digest: 'a'.repeat(64), state: 'accepted', accepted_at: at(), updated_at: at() });
      byDelivery.set(request.delivery_id, acceptance_id);
      queue.push(...deferred, request.delivery_id);
      return { state: 'accepted', acceptance_id };
    },
    wakeReceipt: async (_token: string, acceptanceId: string) => receipts.get(acceptanceId),
    activityV2: async () => {
      await tick();
      return { version: 'noopolis.daimon.organization-runtime-activity.v2',
        items: [...receipts.values()].map(row => ({ ...row, active: false })),
        executions: running ? [{ agent_id: agentId, execution_id: running.executionId, state: 'running',
          delivery_ids: [running.deliveryId] }] : [] };
    },
    availability: async () => ({ version: 'noopolis.daimon.organization-runtime-availability.v2', state: 'ready',
      agents: [{ agent_id: agentId, pending: queue.length, running: !!running, deferred: deferred.length, budget: { state: 'available' } }] }),
    stop: async () => ({ state: 'stopped' }),
  } as unknown as NativeHost;
  return { host, closed };
}

/** The same three wakes a deferred case really runs, through the real controller. */
async function workerFrames(root: string, trialId: string, configSha256: string): Promise<{ frames: TerminalEvidence[]; closed: { executionId: string; deliveryId: string }[] }> {
  for (const directory of ['runtime/telemetry', 'runtime/tool-state', 'runtime/.codex/sessions', 'control']) {
    await mkdir(join(root, directory), { recursive: true });
  }
  await writeFile(join(root, 'runtime/.codex/sessions/unit.jsonl'),
    `${JSON.stringify({ type: 'turn_context', payload: { model: 'test-model-v1' } })}\n`);
  const { host, closed } = daimonFixture(root, trialId, 'agent:writer', wakeId => wakeId !== 'answer-2');
  const options: WorkerOptions = { launch: '/launch', config: '/config', configSha256, controlRoot: join(root, 'control'),
    tokenFile: '/token', evidence: join(root, 'control/evidence.json'), trialId, timeoutMs: 12_000, scheduleOverride: 'disabled' };
  const controller = createWorkerController(host, configFixture(root), options, 'token');
  const frames = [await controller.run('task', 'Assigned work', { maxExternalDeliveries: 2 })];
  for (const wakeId of ['answer-1', 'answer-2']) {
    const text = `A genuinely supplied external answer for ${wakeId}`;
    frames.push(await controller.run(wakeId, text, { source: { kind: 'transport', id: wakeId,
      sha256: `sha256:${createHash('sha256').update(text).digest('hex')}` } }));
  }
  await controller.stop();
  return { frames, closed };
}

/**
 * The whole assumption, end to end, in the shape that broke it live.
 *
 * Every earlier fix passed a test of its own half and failed the next live run,
 * because the worker's poll and the parent's evidence reader are different
 * processes and no test had ever put them on the same trial. This one does: the
 * real controller polls a runtime that revisits its own deferred deliveries, and
 * the frames it publishes — not frames a fixture invented — are what the real
 * reader binds, selects and closes over.
 */
test('a three-wake deferred trial binds each wake to its own execution and scores the wake it names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-multi-wake-'));
  const framesFile = join(root, 'frames.json');
  const fixture = await childFixture('replay', framesFile);
  const worker = await workerFrames(root, fixture.input.trialId, fixture.launch.configSha256);
  try {
    // Six executions for three deliveries: each wake's own, plus the revisits the
    // runtime ran for deliveries this trial had already deferred.
    expect(worker.closed).toHaveLength(6);
    expect(worker.closed.map(row => row.deliveryId)).toEqual(['unit-trial:task', 'unit-trial:task', 'unit-trial:answer-1',
      'unit-trial:task', 'unit-trial:answer-1', 'unit-trial:answer-2']);
    // No wake refused its own trial's history, and none of them reported the count.
    expect(worker.frames.map(frame => frame.error).filter(Boolean)).toEqual([
      'Native execution completed; delivery blocked awaiting external input',
      'Native execution completed; delivery blocked awaiting external input']);
    expect(worker.frames.map(frame => frame.wakeId)).toEqual(['task', 'answer-1', 'answer-2']);
    expect(worker.frames.map(frame => frame.status)).toEqual(['failed', 'failed', 'completed']);
    expect(worker.frames.map(frame => frame.blocked)).toEqual(['awaiting-external-input', 'awaiting-external-input', undefined]);
    // Each frame names the execution the RUNTIME bound to its own delivery — the
    // first one that ran for it, never a revisit of an earlier wake beside it.
    const first = (deliveryId: string) => worker.closed.find(row => row.deliveryId === deliveryId)!.executionId;
    expect(worker.frames.map(frame => frame.executionId)).toEqual(['unit-trial:task', 'unit-trial:answer-1', 'unit-trial:answer-2'].map(first));
    // Wake attribution stays exact; the independent trial ledger retains revisits.
    for (const frame of worker.frames) {
      expect(frame.native.traces.map(row => row.turn_id)).toEqual([frame.executionId]);
      expect(frame.native.usage.map(row => row.wake)).toEqual([frame.executionId]);
    }
    expect(worker.frames.map(frame => frame.native.accounting?.usage.length)).toEqual([1, 3, 6]);
    expect(worker.frames.at(-1)?.native.accounting?.usage.map(row => row.wake)).toEqual(worker.closed.map(row => row.executionId));
    expect(worker.frames.every(frame => frame.native.accounting?.coverage === 'complete')).toBe(true);
    await writeFile(framesFile, JSON.stringify(worker.frames));
    // And the parent reads exactly those frames back over the real loopback.
    const handle = await startOwnedChild({ kind: 'child-process' }, fixture.launch,
      fixture.input.trialId, 20_000, undefined, 20_000, fixture.input.protectedPaths);
    const events: Observation[] = [];
    fixture.input.onObservation = event => { events.push(event); };
    const observer = createNativeObserver(fixture.input, fixture.input.runtimeHomePath, fixture.launch.agent.id);
    const usages: (Usage | null)[] = [];
    for (const frame of worker.frames) {
      const replayed = await handle.request<TerminalEvidence>('/trial/run', { wakeId: frame.wakeId, text: 'replayed' }, 5000);
      expect(replayed.executionId).toBe(frame.executionId);
      usages.push(await observer.terminal(frame.wakeId, replayed));
    }
    expect(sumNativeUsage(usages)).toMatchObject({ inputTokens: 210, outputTokens: 12 });
    expect(events.filter(event => event.type === 'usage').flatMap(event => event.native as unknown[])).toHaveLength(6);
    expect(await observer.terminal('answer-2', worker.frames[2]!)).toBeNull();
    const receipt = await handle.stop('Native trial work ended');
    expect(receipt.state).toBe('acknowledged');
    expect(receipt.quiescence).toBe('confirmed');
    expect(receipt.unconfirmed).toBeUndefined();
    // Quiet AND scorable, and it says which wake it scored.
    expect(receipt.unevidenced).toBeUndefined();
    expect(receipt.evidenced).toBe('answer-2');
    expect(receipt.wakes).toEqual([{ wakeId: 'task' }, { wakeId: 'answer-1' }, { wakeId: 'answer-2' }]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(fixture.root, { recursive: true, force: true });
  }
});


test('the persisted trial ledger counts all six executions once, including revisits', async () => {
  const fixture = await launchFixture();
  const root = await mkdtemp(join(tmpdir(), 'native-multi-accounting-'));
  try {
    const worker = await workerFrames(root, fixture.input.trialId, fixture.launch.configSha256);
    const observer = createNativeObserver(fixture.input, fixture.input.runtimeHomePath, fixture.launch.agent.id);
    const usages: (Usage | null)[] = [];
    for (let index = 0; index < worker.frames.length; index++) {
      const persisted = JSON.parse(await readFile(join(root, `control/evidence.${index + 1}.json`), 'utf8')) as TerminalEvidence;
      expect(persisted.native).toEqual(worker.frames[index]!.native);
      expect(persisted.native.usage.map(row => row.wake)).toEqual([persisted.executionId]);
      usages.push(await observer.terminal(persisted.wakeId, persisted));
    }
    expect(worker.closed).toHaveLength(6);
    expect(sumNativeUsage(usages)).toMatchObject({ inputTokens: 210, outputTokens: 12 });
    expect(worker.frames.at(-1)?.native.accounting?.usage.map(row => row.wake)).toEqual(worker.closed.map(row => row.executionId));
    expect(await observer.terminal('answer-2', worker.frames[2]!)).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(fixture.root, { recursive: true, force: true });
  }
});
