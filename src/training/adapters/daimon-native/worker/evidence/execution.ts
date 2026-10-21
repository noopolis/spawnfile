import type { DeclaredLimit } from '../../../../contracts/execution.js';
import type { NativeActivity, NativeEvidence, NativeReceipt, NativeTrace, NativeUsage } from '../types.js';

/** The closed set Daimon may record on a delivery it returned to the inbox for restart. */
const RECLAIM_CODES: readonly string[] = ['host_stopping', 'host_stopped', 'queued_wake_stopped', 'active_wake_aborted', 'engine_failed'];

export function deferredAfterCompletion(receipt: NativeReceipt, trace: NativeTrace | undefined): boolean {
  return receipt.state === 'accepted' && receipt.deferred === true && trace?.status === 'completed';
}

const DECLARED_LIMITS: readonly string[] = ['tokens', 'requests', 'timeout'];

/**
 * The declared budget a failed execution exhausted, read only from Daimon's
 * declared-limit stop contract: the broker-sealed usage row of that same
 * execution carrying a closed `limit_reason`. Engine-neutral by construction —
 * no engine name, no message prose. Absent row, `none`, or a trace that did not
 * fail all answer `undefined`, so every other failure stays what it was.
 *
 * `timeout` needs more than the row. Daimon seals its idle watchdog (no model
 * request or tool call for minutes, i.e. a hang) as the same `timeout` and does
 * not persist which one ended the turn, so a timeout counts as the subject's
 * budget only when the closed trace's own span reached `wakeTimeoutMs`, the
 * per-wake ceiling this worker configured, within a 1% (at most 5s) tolerance.
 * Without a ceiling a timeout is never labelled.
 */
export function declaredLimitStop(trace: NativeTrace | undefined, usage: readonly NativeUsage[], wakeTimeoutMs?: number): DeclaredLimit | undefined {
  if (trace?.status !== 'failed') return undefined;
  const reason = usage.find(row => row.wake === trace.turn_id && DECLARED_LIMITS.includes(String(row.limit_reason)))?.limit_reason;
  if (reason !== 'timeout') return reason as DeclaredLimit | undefined;
  const span = Date.parse(trace.completed_at) - Date.parse(trace.started_at);
  if (wakeTimeoutMs === undefined || !Number.isFinite(span)) return undefined;
  return span >= wakeTimeoutMs - Math.min(5_000, wakeTimeoutMs * 0.01) ? 'timeout' : undefined;
}

/** A closed execution that stopped on a subject-declared limit; the worker labels its frame from it. */
export class DeclaredLimitStop extends Error {
  constructor(readonly limit: DeclaredLimit, message: string) { super(message); }
}

export function describeNativeFailure(receipt: NativeReceipt, trace: NativeTrace | undefined, usage: readonly NativeUsage[] = []): string {
  if (deferredAfterCompletion(receipt, trace)) return 'Native execution completed; delivery blocked awaiting external input';
  // Daimon records an unmarked finished wake as DEFERRED, so an accepted delivery
  // without that marker is not an agent outcome at all: it is written only where a
  // wake came back stopped and the runtime reclaimed the delivery for restart.
  if (receipt.state === 'accepted' && !receipt.deferred && trace?.status === 'completed') {
    // Daimon records the wake outcome that reclaimed the delivery when it has one, and
    // nothing when it does not. Pass its closed vocabulary through exactly, or say so:
    // "unrecorded" is a different statement from any of the named outcomes. That code
    // is the only thing this process witnessed about the reclaim, so it is the only
    // thing the message claims: `availability.state` is the fuse's verdict, read after
    // the fact and on a different clock from the dispatcher's write, and it cannot say
    // whether the runtime was halting when the record was written.
    const outcome = RECLAIM_CODES.includes(receipt.code ?? '') ? receipt.code : 'unrecorded';
    return `Native execution completed; delivery reclaimed undisposed (${outcome})`;
  }
  const delivery = `${receipt.state}${receipt.deferred ? ' deferred' : ''}`;
  if (trace?.status !== 'failed') return `Native delivery ended ${delivery}`;
  const error = trace.error;
  const message = error && typeof error === 'object' && 'message' in error ? error.message : undefined;
  // Native lifecycle errors may include upstream content. Only this fixed owner
  // message contributes detail; never forward arbitrary trace text or objects.
  const ceiling = typeof message === 'string'
    ? /^Codex wake exceeded its ([0-9]{1,16})-token per-wake ceiling \(turn usage ([0-9]{1,16}) tokens\)$/u.exec(message)
    : null;
  if (ceiling && ceiling[0] === message) {
    return `Native execution failed: Codex wake exceeded its ${ceiling[1]}-token per-wake ceiling (turn usage ${ceiling[2]} tokens)`;
  }
  // Grok broker limits: the sealed usage row's closed limit_reason, else the broker client's fixed code prefix.
  const row = usage.find(item => item.engine === 'grok' && item.wake === trace.turn_id && ['tokens', 'requests', 'timeout'].includes(String(item.limit_reason)));
  const broker = typeof message === 'string' ? /^engine broker turn failed \(limit_exceeded; limit=(tokens|requests|timeout)[;)]/u.exec(message) : null;
  const limit = row ? String(row.limit_reason) : broker?.[1];
  if (limit) return `Native execution failed: Grok broker turn limit_exceeded (limit_reason ${limit})`;
  return `Native execution failed (delivery ${delivery})`;
}

/**
 * How many executions the runtime still admits for this agent, from its own
 * projection and nothing else.
 *
 * This is the live half of quiescence: an execution is admitted while its wake
 * runs and is gone once it closes, so an empty list is the runtime saying that
 * nothing of this agent's is running. It throws rather than answering when the
 * projection cannot carry that claim at all — no execution authority, or a row
 * belonging to another agent — because a count derived from an unaccountable
 * list would be a guess wearing a number.
 */
export function admittedExecutions(activity: NativeActivity, agentId: string): number {
  if (!Array.isArray(activity.executions)) throw new Error('Native activity omitted execution authority');
  if (activity.executions.some(row => row.agent_id !== agentId)) throw new Error('Unexpected native agent execution');
  return activity.executions.length;
}

/**
 * Two closed traces answering to one execution id. Its own word, and exported so
 * a reader can name it on a receipt without matching on prose.
 */
export const AMBIGUOUS_NATIVE_EXECUTION = 'One native execution closed more than once; its terminal evidence is ambiguous';

/** Validate trial-wide attribution before selecting a trace or testing closure. */
export function validateNativeFrame(activity: NativeActivity, receipt: NativeReceipt, traces: NativeEvidence['traces'],
  agentId: string, named?: string): void {
  admittedExecutions(activity, agentId);
  if (receipt.agent_id !== agentId || traces.some(row => row.agent_id !== agentId)) throw new Error('Native execution evidence identity mismatch');
  const ids = new Set<string>();
  for (const trace of traces) {
    if (ids.has(trace.turn_id)) throw new Error(AMBIGUOUS_NATIVE_EXECUTION);
    ids.add(trace.turn_id);
  }
  if (named !== undefined && receipt.execution_id !== undefined && receipt.execution_id !== named) {
    throw new Error('Native execution evidence identity mismatch');
  }
}

/**
 * The closed execution this evidence binds to, or `undefined` when none does.
 *
 * `named` is the execution being accounted for: the one a terminal frame claims,
 * or the one the runtime itself bound to the delivery this wake is still
 * polling. A trial that ran several wakes resolves the trace belonging to THAT
 * execution; the others are the same trial's other wakes and are not competing
 * answers. Nothing is admitted by position or by count.
 *
 * Isolation is the property; arity was only ever standing in for it. Every trace
 * must be this agent's and the receipt must be this agent's, whether or not the
 * trace is the one selected, so a foreign execution is rejected from a set of
 * three exactly as it was from a set of one. The receipt's own `execution_id`,
 * when it carries one, must name the resolved trace. Two traces sharing any execution
 * id invalidate the frame and and throw `AMBIGUOUS_NATIVE_EXECUTION`.
 */
export function executionClosed(activity: NativeActivity, receipt: NativeReceipt, traces: NativeEvidence['traces'],
  agentId: string, named: string): string | undefined {
  validateNativeFrame(activity, receipt, traces, agentId, named);
  if (admittedExecutions(activity, agentId) > 0) return undefined;
  return traces.find(row => row.turn_id === named)?.turn_id;
}

/**
 * The execution the runtime itself bound to THIS delivery, or `undefined` while
 * it has not said.
 *
 * Both sources are the runtime's own statements about this delivery rather than
 * an inference from how many traces exist. The wake receipt names the execution
 * that claimed the delivery; the live activity projection lists each admitted
 * execution beside the delivery ids it covers. Daimon clears the receipt's
 * execution id the moment the subject defers the delivery — while that execution
 * is still admitted and still running — so the projection is what answers for a
 * deferred wake and the receipt is what answers for a completed one. Either is
 * enough, neither is guessed, and a claim once observed is kept.
 *
 * Reading it is not an optimisation. A new delivery makes Daimon revisit this
 * trial's still-deferred deliveries first, so while this wake waits its turn the
 * runtime legitimately opens, closes and files executions that answer for
 * ANOTHER of this trial's wakes. "The trace that appeared since I started" cannot
 * tell those apart from this delivery's own, and every way of counting them was
 * wrong: one new trace was attributed to the wrong wake, two refused a healthy
 * trial outright.
 */
export function claimedExecution(receipt: NativeReceipt, activity: NativeActivity, deliveryId: string, agentId: string): string | undefined {
  if (receipt.agent_id === agentId && receipt.delivery_id === deliveryId && typeof receipt.execution_id === 'string') return receipt.execution_id;
  return (activity.executions ?? []).find(row => row.agent_id === agentId && row.delivery_ids.includes(deliveryId))?.execution_id;
}

/** One delivery disposed of, with more than one execution of this trial left unattributed to it. */
export const AMBIGUOUS_WAKE_EXECUTION = 'One native delivery closed with more than one unattributed execution';

/**
 * The execution this delivery closed when the runtime never named one, or
 * `undefined` while the question cannot be asked yet.
 *
 * It can only be asked of a delivery the runtime has already disposed of —
 * completed, failed, or marked deferred by the subject — on a runtime that
 * admits no execution at all. That conjunction, and nothing weaker, is what says
 * this delivery's own execution has ended: the disposition is written during the
 * turn, so it does not prove closure by itself, and an idle projection does not
 * say whose turn ended. Both together do.
 *
 * `history` is every execution of this trial already accounted for elsewhere, so
 * what remains is what closed inside this wake's own window. Exactly one answers
 * for it. Two is not a trial with several wakes — those are in `history` — it is
 * one delivery with two unattributable executions, and it fails closed under its
 * own name rather than picking the first.
 */
export function disposedWakeExecution(receipt: NativeReceipt, traces: NativeEvidence['traces'], history: ReadonlySet<string>): string | undefined {
  if (!['completed', 'failed'].includes(receipt.state) && receipt.deferred !== true) return undefined;
  const added = traces.filter(row => !history.has(row.turn_id));
  if (added.length > 1) throw new Error(AMBIGUOUS_WAKE_EXECUTION);
  return added[0]?.turn_id;
}
