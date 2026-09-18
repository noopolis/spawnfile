import { afterEach, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { createDaimonNativeAdapter } from '../index.js';
import { childFixture } from './fixture.js';
import { filing, nativeDeferredTrial } from './deferred-trial.js';
import { startOwnedChild } from './lifecycle.js';
import { createEvaluationRegistry } from '../../../evaluation/index.js';
import { runTrial, trialScore } from '../../../experiments/index.js';
import type { SubjectAdapter, SubjectSession } from '../../../contracts/execution.js';

vi.mock('./sandbox.js', () => ({ verifyChildSandbox: vi.fn(async () => undefined) }));
const roots: string[] = [];
afterEach(async () => { vi.clearAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
/** Every deferred trial below writes a real workspace and control root; the caller owns them. */
const deferredTrial = async (...args: Parameters<typeof nativeDeferredTrial>) => {
  const outcome = await nativeDeferredTrial(...args);
  roots.push(outcome.root);
  return outcome;
};

/**
 * The gap this closes. A subject that ran every wake its budget allowed, spent the
 * money, deferred each delivery and never filed the article is a behavioural zero —
 * but proving it needs the closure receipt, and the receipt needs the v2 activity
 * projection from a host the worker has *already* stopped. Daimon answered 503
 * `native_host_unavailable` there, so the trial demoted to an unscorable
 * infrastructure failure. The receipt below is obtained, never assumed.
 */
it('scores a zero for a subject that exhausted its continuation budget still deferred', async () => {
  const { report, turn, deliveries } = await deferredTrial('blocked-always');
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
 * The last named blocker on a training loop, and it follows straight from
 * continuations working. A subject that defers gets one, so a trial that really
 * runs three wakes really closes three executions and every frame carries the
 * whole history. The evidence reader counted them and refused — `unevidenced`,
 * nothing to score — about a trial whose runtime was provably quiet and whose own
 * frame named exactly which execution it was accounting for. It resolves that one
 * now; the others are this trial's own earlier wakes, not foreign work.
 *
 * The boundary this straddles is the terminal frame itself: the worker process
 * builds it and the evaluator parent reads it over HTTP, and the parent may not
 * assume the worker stripped its own history out of the trace set before sending.
 */
it('resolves the execution a three-wake trial\'s frame names and scores the run', async () => {
  const { report, turn, deliveries } = await deferredTrial('blocked-always-history', 2);
  // Three wakes really ran: the task plus both continuations the budget admitted.
  expect(deliveries).toBe(2);
  expect(turn).toMatchObject({ status: 'failed', blocked: 'awaiting-external-input' });
  expect(turn.usage?.inputTokens).toBe(300);
  // Quiet AND scorable: neither name is on the receipt, and no arity was consulted.
  expect(report.stop).toMatchObject({ state: 'acknowledged', quiescence: 'confirmed' });
  expect(report.stop?.unevidenced).toBeUndefined();
  expect(report.stop?.unconfirmed).toBeUndefined();
  expect(report.error).not.toContain('want of terminal evidence');
  // A scored trial says which wake it was scored from, and keeps every wake beside it.
  expect(report.stop?.evidenced).toBe('answer-1');
  expect(report.stop?.wakes?.map(wake => wake.wakeId)).toEqual(['task', 'answer-0', 'answer-1']);
  // Deferred is still never success; it is a measured zero rather than an unscorable run.
  expect(report.execution).toBe('deferred');
  expect(report.status).toBe('fail');
  expect(trialScore(report)).toBe(0);
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
  const { report, turn } = await deferredTrial(mode);
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
  const { report, turn } = await deferredTrial('blocked-always-stop-unknown');
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
  ['blocked-always', undefined, undefined],
  ['blocked-always-unanswerable', 'activity-unreadable', undefined],
  ['blocked-always-stop-unknown', 'native-stop-unacknowledged', undefined],
  ['blocked-always-busy-seal', 'activity-busy', undefined],
  // A delivery the runtime reclaimed undisposed is a SCORING fact, not a closure
  // one: the child exited, the terminal frame was published and bound, and
  // `executions` is empty, so nothing is still spending. Closure holds and the
  // scoring path refuses it on its own — see the trial below.
  ['blocked-no-deferred', undefined, undefined],
  // And a frame carrying another trial's identity is the other half of the split:
  // the runtime is provably quiet and this trial still has nothing to be scored
  // from. Closure and evidence, named apart.
  ['bad-terminal', undefined, 'terminal-unbound'],
])('binds %s to the closure cause %s and the evidence cause %s', async (mode, cause, missing) => {
  const f = await childFixture(mode); roots.push(f.root);
  const handle = await startOwnedChild({ kind: 'child-process' }, f.launch, f.input.trialId, 2_000);
  await handle.request('/trial/run', { wakeId: 'task', text: 'Work', ...(mode === 'blocked-no-deferred' ? {} : { controls: { maxExternalDeliveries: 0 } }) });
  const receipt = await handle.stop('Closure cause');
  expect(receipt.unconfirmed).toBe(cause);
  expect(receipt.unevidenced).toBe(missing);
  expect(receipt.quiescence).toBe(cause ? 'unknown' : 'confirmed');
  expect(receipt.detail).toContain(cause ?? missing ?? 'Closed native execution');
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
  const { report, turn, deliveries } = await deferredTrial('undisposed', 3, async () => null);
  // One wake, and no continuation was asked for: an undisposed delivery is not a deferral.
  expect(deliveries).toBe(0);
  expect(turn.status).toBe('failed');
  expect(turn.blocked).toBeUndefined();
  // The wake outcome Daimon recorded is the evidence, and it travels all the way to
  // the published turn. Nothing claims which runtime did the reclaiming: that read
  // was never witnessed by this process.
  expect(turn.error).toContain('reclaimed undisposed (active_wake_aborted)');
  expect(turn.error).not.toContain('runtime kept running');
  // Closure is PROVEN: the child exited, the terminal frame bound and `executions`
  // is empty, which is the whole of "no worker is still spending". An undisposed
  // delivery is a scoring fact and was demoting a scorable trial to an
  // infrastructure failure from inside the closure predicate; it is not a cause here
  // any more, and no name replaced it.
  expect(report.stop).toMatchObject({ state: 'acknowledged', quiescence: 'confirmed' });
  expect(report.stop?.unconfirmed).toBeUndefined();
  // Still refusing to score, and loudly — on the turn's own evidence, not on a
  // closure proof it never failed.
  expect(report.error).not.toContain('Native closure unproven');
  // The turn's own sentence already explains the trial, so it is not prefixed with a
  // closure cause that would read as the primary fault; the machine-readable name on
  // the receipt is what an operator correlates, and the two must agree.
  expect(report.error).toContain('reclaimed undisposed (active_wake_aborted)');
  expect(report.execution).toBe('failed');
  expect(() => trialScore(report)).toThrow('failed in infrastructure');
});

/**
 * A worker that was never given a delivery is quiet and has nothing to be scored
 * from, and those are two statements, not one. It used to publish as unproven
 * containment — "the runtime might still be spending" — about a runtime that had
 * admitted no execution, acknowledged its stop and exited.
 */
it('names an absent terminal frame as missing evidence, not as doubtful containment', async () => {
  const f = await childFixture('stall'); roots.push(f.root);
  const handle = await startOwnedChild({ kind: 'child-process' }, f.launch, f.input.trialId, 1_000);
  const receipt = await handle.stop('Nothing was ever delivered');
  expect(receipt).toMatchObject({ state: 'acknowledged', quiescence: 'confirmed', unevidenced: 'terminal-absent' });
  expect(receipt.unconfirmed).toBeUndefined();
  expect(receipt.detail).toContain('no terminal evidence to score this trial (terminal-absent)');
});

/**
 * And an activity projection nobody can account for is never read as quiet. A row
 * belonging to another agent means this runtime is not the one this trial thinks it
 * is talking to, or its projection cannot be trusted to list this agent's work
 * either; both fail closed rather than resolving to a count.
 */
it('refuses closure for an activity projection carrying another agent\'s execution', async () => {
  const f = await childFixture('foreign-execution'); roots.push(f.root);
  const handle = await startOwnedChild({ kind: 'child-process' }, f.launch, f.input.trialId, 2_000);
  expect(await handle.stop('Unaccountable projection')).toMatchObject({ state: 'unknown', quiescence: 'unknown',
    unconfirmed: 'execution-unbound' });
});

/**
 * The money guarantee, on the only authority that can answer it. The same worker
 * given a wake it never finishes is still inside that wake: its runtime admits the
 * execution, and closure is refused for as long as it does — no frame, receipt or
 * inbox disposition is consulted, and none would have added anything, because every
 * one of them is the same runtime's account of the same turn read one step later.
 */
it('refuses closure for a worker that is still inside its wake', async () => {
  const f = await childFixture('stall'); roots.push(f.root);
  const handle = await startOwnedChild({ kind: 'child-process' }, f.launch, f.input.trialId, 2_000);
  const pending = handle.request('/trial/run', { wakeId: 'task', text: 'Work' }).catch(() => undefined);
  await vi.waitFor(async () => expect((await handle.request<{ executions: unknown[] }>('/v2/activity')).executions).toHaveLength(1));
  const receipt = await handle.stop('Worker never answered');
  expect(receipt).toMatchObject({ state: 'unknown', quiescence: 'unknown', unconfirmed: 'activity-busy' });
  expect(receipt.detail).toContain('caller must stop the shared container');
  await pending;
});

/**
 * The shape seven investigations ended on. A subject that really ran, really
 * deferred, left an idle runtime, acknowledged its stop and exited cleanly — and
 * whose terminal frame did not resolve to the execution it named. That is a
 * scoring fault and nothing else, and for as long as it was read inside the
 * closure predicate the trial published `unconfirmed (terminal-unbound)`: the
 * machine claiming a worker might still be spending money, about a runtime it had
 * just proven quiet. It still refuses to score, under its own name.
 */
it('reports an unbound terminal frame as unscorable evidence, not as unproven closure', async () => {
  const { report, turn } = await deferredTrial('blocked-wrong-execution', 3, async () => null);
  // The subject's own run was healthy: it deferred its delivery after a closed trace.
  expect(turn).toMatchObject({ status: 'failed', blocked: 'awaiting-external-input' });
  // Closure is PROVEN: no admitted execution, an acknowledged stop and a clean exit.
  expect(report.stop).toMatchObject({ state: 'acknowledged', quiescence: 'confirmed', unevidenced: 'terminal-unbound' });
  expect(report.stop?.unconfirmed).toBeUndefined();
  // And the trial says which of the two it was, in words an operator can act on.
  expect(report.error).toContain('Native trial unscorable for want of terminal evidence (terminal-unbound)');
  expect(report.error).not.toContain('Native closure unproven');
  expect(report.error).toContain('delivery blocked awaiting external input');
  // Unscorable is still never a pass: deferred work is not training evidence.
  expect(report.execution).toBe('failed');
  expect(() => trialScore(report)).toThrow('failed in infrastructure');
});
