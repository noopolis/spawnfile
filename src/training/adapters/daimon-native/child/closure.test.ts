import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createDaimonNativeAdapter } from '../index.js';
import { childFixture } from './fixture.js';
import { startOwnedChild } from './lifecycle.js';
import { parseDatasetYaml, resolveDataset } from '../../../cases/index.js';
import { createEvaluationRegistry } from '../../../evaluation/index.js';
import { runTrial, trialScore, type TrialOptions, type TrialReport } from '../../../experiments/index.js';
import type { SubjectAdapter, SubjectSession, SubjectTurnResult } from '../../../contracts/execution.js';

vi.mock('./sandbox.js', () => ({ verifyChildSandbox: vi.fn(async () => undefined) }));
const roots: string[] = [];
afterEach(async () => { vi.clearAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/** One required artifact the filing would produce, so the verdict is exactly the subject's. */
const filing = () => resolveDataset(parseDatasetYaml(`schema: paideia.dataset.v1
id: newsroom
stages:
  - id: accepted-article
    checks:
      - {id: filed, eval: tool-called, tool: mcp_newsroom_file_article}
      - {id: body, eval: contains-any, input: 'artifact:accepted-article#/body', values: [Filed]}
    score:
      linear: {filed: 0.5, body: 0.5}
    gate: {all: [{passed: filed}, {passed: body}]}
records:
  - id: record
    group: unique
    input: {prompt: file the assigned story}
    outputs: {accepted-article: article.json}
`)).records[0]!;

/**
 * The real child, the real loopback protocol and the real closure query: the only
 * thing borrowed is the trial's own stimulus, because the worker owns the fresh
 * workspace the launch receipt pins. Every continuation the budget admits defers,
 * so the last one exhausts it — and by then the worker has stopped its own host.
 */
async function nativeDeferredTrial(mode: string, maxDeliveries = 1,
  supplied?: () => Promise<null>): Promise<{ report: TrialReport; turn: SubjectTurnResult; deliveries: number }> {
  const fixture = await childFixture(mode); roots.push(fixture.root);
  const text = 'Sourced research reply';
  let asked = 0;
  const sourced = async () => { const id = `answer-${asked++}`;
    return { id, text, source: { kind: 'transport', id, sha256: `sha256:${createHash('sha256').update(text).digest('hex')}` } }; };
  const next = supplied ? async () => { asked++; return supplied(); } : sourced;
  const native = createDaimonNativeAdapter({ timeoutMs: 20_000, execution: { kind: 'child-process', externalInputs: { maxDeliveries, next } } });
  const session = await native.start(fixture.input);
  let turn: SubjectTurnResult | undefined;
  const adapter: SubjectAdapter = { id: 'daimon-native-child', capabilities: native.capabilities,
    async start(): Promise<SubjectSession> {
      return { run: async (value, signal) => { turn = await session.run({ id: value.id, text: value.text }, signal); return turn; },
        stop: reason => session.stop(reason) };
    } };
  const options: TrialOptions = { id: fixture.input.trialId, phase: 'train', record: filing(), candidateId: 'candidate',
    datasetDigest: 'dataset', planDigest: 'plan', adapter, model: fixture.input.model!, root: fixture.root, timeoutMs: 20_000,
    prepare: async () => ({ instructions: fixture.input.instructions }), registry: createEvaluationRegistry(),
    evaluation: { judges: {}, embeddings: {}, readText: async () => { throw new Error('unregistered sidecar'); } },
    persist: async () => undefined };
  const report = await runTrial(options);
  return { report, turn: turn!, deliveries: asked };
}

/**
 * The gap this closes. A subject that ran every wake its budget allowed, spent the
 * money, deferred each delivery and never filed the article is a behavioural zero —
 * but proving it needs the closure receipt, and the receipt needs the v2 activity
 * projection from a host the worker has *already* stopped. Daimon answered 503
 * `native_host_unavailable` there, so the trial demoted to an unscorable
 * infrastructure failure. The receipt below is obtained, never assumed.
 */
it('scores a zero for a subject that exhausted its continuation budget still deferred', async () => {
  const { report, turn, deliveries } = await nativeDeferredTrial('blocked-always');
  // The turn really deferred and the continuation budget really ran out.
  expect(turn).toMatchObject({ status: 'failed', blocked: 'awaiting-external-input' });
  expect(turn.error).toBe('Native execution completed; delivery blocked awaiting external input');
  expect(deliveries).toBe(1);
  // Obtained from the stopped host's sealed projection, not stipulated by a stub.
  expect(turn.stop).toMatchObject({ state: 'acknowledged', quiescence: 'confirmed' });
  expect(report.stop).toMatchObject({ state: 'acknowledged', quiescence: 'confirmed' });
  expect(report.execution).toBe('deferred');
  expect(report.hostWork).toBe('settled');
  // Deferred is never success: the unanswered delivery is the failing witness, and
  // the measured checks keep their own honest verdicts rather than becoming zeros.
  expect(report.status).toBe('fail');
  expect(report.evaluation.stages[0]!.checks.map(check => check.status)).toEqual(['unknown', 'unknown']);
  expect(report.evaluation.stages[0]!.gate.status).not.toBe('pass');
  expect(trialScore(report)).toBe(0);
  // Both wakes were metered and neither became completed training evidence.
  expect(turn.usage?.inputTokens).toBe(200);
  expect(report.snapshot.output).toBe('');
});

/**
 * The guard that keeps this from becoming "score everything". Each of these really
 * ran and none of them can prove its execution closed, so each stays an
 * infrastructure failure and refuses to produce a number.
 *
 * `blocked-always-unanswerable` is the observed pre-fix host: the delivery deferred
 * and the budget ran out exactly as above, and the only difference is that the
 * closure query is not answered. `die-mid-turn` crashes the worker and `stall`
 * never replies until the caller cancels it.
 */
it.each([
  ['blocked-always-unanswerable', 'failed'],
  ['die-mid-turn', 'failed'],
])('refuses to score an execution whose closure is unproven: %s', async (mode, execution) => {
  const { report, turn } = await nativeDeferredTrial(mode);
  expect(report.execution).toBe(execution);
  expect(turn.stop?.quiescence ?? 'unknown').toBe('unknown');
  expect(report.stop).toMatchObject({ quiescence: 'unknown' });
  expect(report.status).toBe('error');
  expect(() => trialScore(report)).toThrow('failed in infrastructure');
});

it('refuses to score a cancelled execution even when the subject had really deferred', async () => {
  const fixture = await childFixture('stall'); roots.push(fixture.root);
  const native = createDaimonNativeAdapter({ timeoutMs: 1_000, execution: { kind: 'child-process' } });
  const session = await native.start(fixture.input);
  const adapter: SubjectAdapter = { id: 'daimon-native-child', capabilities: native.capabilities,
    async start(): Promise<SubjectSession> {
      return { run: (value, signal) => session.run({ id: value.id, text: value.text }, signal), stop: reason => session.stop(reason) };
    } };
  const report = await runTrial({ id: fixture.input.trialId, phase: 'train', record: filing(), candidateId: 'candidate',
    datasetDigest: 'dataset', planDigest: 'plan', adapter, model: fixture.input.model!, root: fixture.root, timeoutMs: 700,
    prepare: async () => ({ instructions: fixture.input.instructions }), registry: createEvaluationRegistry(),
    evaluation: { judges: {}, embeddings: {}, readText: async () => { throw new Error('unregistered sidecar'); } },
    persist: async () => undefined });
  // The deadline cancelled a worker that never answered: containment is unknown and
  // the trial is the machine's outcome, never a measured behavioural zero.
  expect(report.execution).toBe('interrupted');
  expect(report.stop).toMatchObject({ quiescence: 'unknown' });
  expect(() => trialScore(report)).toThrow(/incomplete/u);
});

/**
 * Why this exists at all. Closure is a conjunction of independent proofs, and a
 * live run that fails it published one sentence — "unconfirmed" — for every one
 * of them. The evidence that would have named the missing proof was in the
 * worker's control root, which a training slot puts on tmpfs that dies with the
 * container, so two sessions in a row had to guess which proof was absent while
 * a verified-correct Daimon seal sat behind an unscorable trial. Each proof now
 * names itself, in a closed vocabulary, on the receipt the turn publishes.
 *
 * `-stop-unknown` is the production shape a kinder fixture could not express:
 * the worker settles its own stop once, races `host.stop()` against a 5s
 * deadline and memoizes the result, so every later `/trial/stop` replays that
 * same non-acknowledgement however well the activity seal answers.
 */
it('names the closure proof that failed instead of publishing one unconfirmed sentence', async () => {
  const { report, turn } = await nativeDeferredTrial('blocked-always-stop-unknown');
  // The subject's own outcome is unchanged: it deferred and spent its budget.
  expect(turn).toMatchObject({ status: 'failed', blocked: 'awaiting-external-input' });
  // The machine could not prove closure, and says which proof was missing.
  expect(report.stop).toMatchObject({ state: 'unknown', quiescence: 'unknown', unconfirmed: 'native-stop-unacknowledged' });
  expect(report.stop?.detail).toContain('native-stop-unacknowledged');
  // The trial's own error names the missing proof rather than republishing the
  // subject's deferral as the reason the machine could not score it.
  expect(report.error).toContain('Native closure unproven (native-stop-unacknowledged)');
  expect(report.error).toContain('delivery blocked awaiting external input');
  // Unproven closure still refuses to score: naming the cause never grants the proof.
  expect(report.execution).toBe('failed');
  expect(() => trialScore(report)).toThrow('failed in infrastructure');
});

/**
 * Every named cause is the one that actually held, and none of them scores. The
 * confirmed path carries no name at all, because absence means the proof held.
 */
it.each([
  ['blocked-always', undefined],
  ['blocked-always-unanswerable', 'activity-unreadable'],
  ['blocked-always-stop-unknown', 'native-stop-unacknowledged'],
  ['blocked-always-busy-seal', 'activity-busy'],
  ['blocked-no-deferred', 'delivery-undisposed'],
  ['bad-terminal', 'terminal-unbound'],
])('binds %s to the closure cause %s', async (mode, cause) => {
  const f = await childFixture(mode); roots.push(f.root);
  const handle = await startOwnedChild({ kind: 'child-process' }, f.launch, f.input.trialId, 2_000);
  await handle.request('/trial/run', { wakeId: 'task', text: 'Work', ...(mode === 'blocked-no-deferred' ? {} : { controls: { maxExternalDeliveries: 0 } }) });
  const receipt = await handle.stop('Closure cause');
  expect(receipt.unconfirmed).toBe(cause);
  expect(receipt.quiescence).toBe(cause ? 'unknown' : 'confirmed');
});

/**
 * The child's own exit is its own cause, decided after the kill escalation rather
 * than blamed on the closure evidence: this worker ignores SIGTERM, so it leaves
 * only under SIGKILL and never reports a clean exit, whatever its runtime proved.
 */
it('names the worker exit rather than blaming its closure evidence', async () => {
  const f = await childFixture('ignore-term'); roots.push(f.root);
  const handle = await startOwnedChild({ kind: 'child-process' }, f.launch, f.input.trialId, 2_000);
  await handle.request('/trial/run', { wakeId: 'task', text: 'Work', controls: { maxExternalDeliveries: 0 } });
  expect(await handle.stop('Finish')).toMatchObject({ quiescence: 'unknown', unconfirmed: 'child-exit' });
});

/**
 * The shape the live run actually produced, which the exhausted-budget test above
 * does not reach: ONE wake, continuation budget untouched, and a delivery the
 * runtime reclaimed without disposing of it. Every binding the closure proof
 * checks held — the frame was published, its identity matched and
 * `executionClosed` agreed — so `terminal-unbound` was the wrong name for it, and
 * the right one has to be its own, because the fix it calls for is not in Paideia.
 */
it('names a delivery the runtime reclaimed undisposed, after a single wake with budget left', async () => {
  const { report, turn, deliveries } = await nativeDeferredTrial('undisposed', 3, async () => null);
  // One wake, and no continuation was asked for: an undisposed delivery is not a deferral.
  expect(deliveries).toBe(0);
  expect(turn.status).toBe('failed');
  expect(turn.blocked).toBeUndefined();
  // The live discriminator: the runtime was still RUNNING when it reclaimed the
  // delivery, so this was never a shutdown race Paideia could reorder away.
  expect(turn.error).toContain('reclaimed undisposed while the runtime kept running');
  // Named as itself, and still refusing to score: nothing here evidences the subject.
  expect(report.stop).toMatchObject({ quiescence: 'unknown', unconfirmed: 'delivery-undisposed' });
  // The turn's own sentence already explains the trial, so it is not prefixed with a
  // closure cause that would read as the primary fault; the machine-readable name on
  // the receipt is what an operator correlates, and the two must agree.
  expect(report.error).toContain('reclaimed undisposed while the runtime kept running');
  expect(report.execution).toBe('failed');
  expect(() => trialScore(report)).toThrow('failed in infrastructure');
});

/** A delivery that never produced a terminal frame at all is a fourth, separate state. */
it('names an absent terminal frame rather than an unbound one', async () => {
  const f = await childFixture('stall'); roots.push(f.root);
  const handle = await startOwnedChild({ kind: 'child-process' }, f.launch, f.input.trialId, 1_000);
  expect(await handle.stop('Nothing was ever delivered')).toMatchObject({ quiescence: 'unknown', unconfirmed: 'terminal-absent' });
});
