import { createDeliveryGate, type DeliveryControls } from './deliveries.js';
import { dirname, join } from 'node:path';
import { collectNativeEvidence, nativeUsageCoverage, readClosedTraces, wakeEvidenceFile, writeEvidence } from './evidence/index.js';
import { isGrokLaunch, type NativeLaunch } from '../receipt/index.js';
import type { NativeActivity, NativeAvailability, NativeConfig, NativeEvidence, NativeEvidenceSource, NativeHost,
  NativeReceipt, NativeTrace, NativeUsage, TerminalEvidence, WorkerOptions } from './types.js';

export interface NativeStopEvidence {
  schema: 'paideia.daimon-native.stop.v1';
  state: 'acknowledged' | 'unknown';
  quiescence: 'unknown';
  containmentVerification: 'parent-container-owner';
  native?: unknown;
  error?: string;
}
export interface WorkerController {
  host: NativeHost;
  run(wakeId: string, text: string, controls?: DeliveryControls): Promise<TerminalEvidence>;
  stop(): Promise<NativeStopEvidence>;
}

/** The closed set Daimon may record on a delivery it returned to the inbox for restart. */
const RECLAIM_CODES: readonly string[] = ['host_stopping', 'host_stopped', 'queued_wake_stopped', 'active_wake_aborted', 'engine_failed'];

function deferredAfterCompletion(receipt: NativeReceipt, trace: NativeTrace | undefined): boolean {
  return receipt.state === 'accepted' && receipt.deferred === true && trace?.status === 'completed';
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
 * when it carries one, must name the resolved trace. Two traces sharing the named
 * id resolve to neither and throw `AMBIGUOUS_NATIVE_EXECUTION`.
 */
export function executionClosed(activity: NativeActivity, receipt: NativeReceipt, traces: NativeEvidence['traces'],
  agentId: string, named: string): string | undefined {
  if (admittedExecutions(activity, agentId) > 0) return undefined;
  if (receipt.agent_id !== agentId || traces.some(row => row.agent_id !== agentId)) throw new Error('Native execution evidence identity mismatch');
  const matching = traces.filter(row => row.turn_id === named);
  if (matching.length > 1) throw new Error(AMBIGUOUS_NATIVE_EXECUTION);
  const trace = matching[0];
  if (!trace) return undefined;
  if (receipt.execution_id !== undefined && receipt.execution_id !== trace.turn_id) throw new Error('Native execution evidence identity mismatch');
  return trace.turn_id;
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

export function createWorkerController(host: NativeHost, config: NativeConfig, options: WorkerOptions,
  token: string, launch?: NativeLaunch): WorkerController {
  const agent = config.agents[0]!;
  if (agent.engine.kind === 'grok' && (!launch || !isGrokLaunch(launch))) throw new Error('Grok native trials require their Grok broker launch receipt');
  const grok = launch && isGrokLaunch(launch) ? launch : undefined;
  const usageFile = grok ? grok.broker.usageLedgerPath : join(options.controlRoot, 'usage.jsonl');
  const source: NativeEvidenceSource = grok ? { engine: 'grok', requestsFile: join(dirname(usageFile), 'requests.jsonl') } : { engine: 'codex' };
  const cancellation = new AbortController();
  const gate = createDeliveryGate(options.timeoutMs, agent.attention?.maxExecutions);
  /** This trial's delivery ordinal, so each wake's frame is filed under a name no later wake reuses. */
  let delivered = 0;
  let stopping: Promise<NativeStopEvidence> | undefined;
  const owned = <T>(operation: Promise<T>): Promise<T> => {
    if (cancellation.signal.aborted) return Promise.reject(new Error('Native trial cancelled'));
    return new Promise((resolve, reject) => {
      const aborted = (): void => reject(new Error('Native trial cancelled'));
      cancellation.signal.addEventListener('abort', aborted, { once: true });
      void operation.then(resolve, reject).finally(() => cancellation.signal.removeEventListener('abort', aborted));
    });
  };
  const stop = (): Promise<NativeStopEvidence> => {
    cancellation.abort();
    stopping ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const native = await Promise.race([host.stop(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Native shutdown deadline exceeded')), 5000);
        })]);
        return { schema: 'paideia.daimon-native.stop.v1', state: 'acknowledged', quiescence: 'unknown',
          containmentVerification: 'parent-container-owner', native } as const;
      } catch (error) {
        return { schema: 'paideia.daimon-native.stop.v1', state: 'unknown', quiescence: 'unknown',
          containmentVerification: 'parent-container-owner', error: String(error) } as const;
      } finally { clearTimeout(timer); }
    })();
    return stopping;
  };
  return {
    host, stop,
    async run(wakeId, text, controls) {
      if (cancellation.signal.aborted) throw new Error('Worker accepts exactly one native trial delivery');
      const remaining = gate.begin(wakeId, text, controls);
      const ordinal = ++delivered;
      /**
       * Every execution of this trial that is not this wake's, from the runtime's
       * own account of them: the ones earlier wakes closed, and the ones it runs
       * for another of this trial's deliveries while this wake waits. It is the
       * set this wake's evidence is separated FROM, never a set anything is
       * selected out of, and a member of it is this trial's own history rather
       * than foreign work.
       */
      const history = new Set<string>(gate.executions);
      /**
       * That set at the moment it is read, with this wake's own execution taken
       * back out of it — the one it bound AND the one the runtime claimed for this
       * delivery, so a wake that failed before it could bind still keeps its own
       * spend and its own trace on the frame it publishes.
       */
      const others = (): string[] => [...history].filter(id => id !== executionId && id !== claimed);
      const startedAt = new Date().toISOString();
      const deliveryId = `${options.trialId}:${wakeId}`;
      let receipt: NativeReceipt | undefined;
      let activity: NativeActivity | undefined;
      let availability: NativeAvailability | undefined;
      /** The execution the runtime bound to this delivery, once it has said which. */
      let claimed: string | undefined;
      let executionId: string | undefined;
      let status: TerminalEvidence['status'];
      let error: string | undefined;
      let blocked: TerminalEvidence['blocked'];
      let native: NativeEvidence = { traces: [], usage: [], toolReceipts: [], modelContexts: [] };
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; void stop(); }, remaining);
      try {
        // Whatever this trial had already closed before this delivery existed. The
        // runtime home is asserted empty at startup and every trace in it is refused
        // unless it is this agent's, so the rows here are this trial's earlier wakes
        // by construction rather than by counting.
        for (const trace of await owned(readClosedTraces(agent.runtimeHomePath, agent.id))) history.add(trace.turn_id);
        const accepted = await owned(host.accept({ token, agent_id: agent.id, delivery_id: deliveryId,
          event: { version: 'noopolis.daimon.wake.v2', kind: 'manual', text, occurred_at: startedAt } }));
        if (accepted.state !== 'accepted') throw new Error(`Native acceptance refused: ${accepted.code}`);
        while (true) {
          if (cancellation.signal.aborted) throw new Error(timedOut ? 'Native trial deadline exceeded' : 'Native trial cancelled');
          [receipt, activity, availability] = await owned(Promise.all([
            host.wakeReceipt(token, accepted.acceptance_id), host.activityV2(token), host.availability(token),
          ]));
          if (!receipt || !activity || !availability) throw new Error('Authenticated native control evidence disappeared');
          if (receipt.delivery_id !== deliveryId || receipt.agent_id !== agent.id) throw new Error('Native receipt identity mismatch');
          if (!Array.isArray(activity.executions)) throw new Error('Native activity omitted execution authority');
          // The runtime's own binding of this delivery to an execution, and its own
          // account of everything else it is running for this trial meanwhile.
          claimed = claimedExecution(receipt, activity, deliveryId, agent.id) ?? claimed;
          for (const row of activity.executions) if (row.agent_id === agent.id) history.add(row.execution_id);
          if (!activity.executions.length) {
            const traces = await readClosedTraces(agent.runtimeHomePath, agent.id);
            // The runtime's own binding first; only for a delivery it has disposed
            // of, on a runtime admitting nothing, may this wake answer for the
            // execution that closed inside its own window instead.
            claimed ??= disposedWakeExecution(receipt, traces, history);
            if (claimed) {
              executionId = executionClosed(activity, receipt, traces, agent.id, claimed);
              if (executionId) {
                receipt = await owned(host.wakeReceipt(token, accepted.acceptance_id));
                activity = await owned(host.activityV2(token));
                availability = await owned(host.availability(token));
                if (!receipt || !activity || !availability) throw new Error('Authenticated terminal control evidence disappeared');
                executionId = executionClosed(activity, receipt, traces, agent.id, claimed);
                if (executionId) break;
              }
            }
            const failure = availability.agents.find(row => row.agent_id === agent.id)?.error;
            if (failure) throw new Error(`Native execution failed before terminal telemetry: ${failure}`);
            // Budget snapshots can pause immediately after this execution was admitted.
            // Only its closed trace or the bounded deadline can establish completion.
          }
          await pause(100, cancellation.signal);
        }
        native = await collectNativeEvidence(agent.runtimeHomePath, usageFile, agent.id, executionId, agent.engine.model!, others(), source);
        // The trace this wake's own execution closed, never whichever one came
        // first: an unbound wake has no trace to speak for it, and reading another
        // wake's would report that wake's disposition as this delivery's.
        const trace = native.traces.find(row => row.turn_id === executionId);
        const failure = availability.agents.find(row => row.agent_id === agent.id)?.error;
        if (!native.usage.length) {
          // Name what WAS observed: a bare "no usage" cannot distinguish a turn that never ran from
          // one that ran without metering, and the runtime home is wiped with the slot.
          const observed = `traces=${native.traces.length} contexts=${native.modelContexts.length} requests=${native.requests?.length ?? 0}`;
          throw new Error(`Closed native execution omitted token usage evidence (${observed} receipt=${receipt.state} execution=${executionId ?? 'none'}${failure ? ` availability=${failure}` : ''})`);
        }
        if (!native.modelContexts.length) throw new Error('Closed native execution omitted model identity evidence');
        if (!failure && deferredAfterCompletion(receipt, trace)) blocked = 'awaiting-external-input';
        if (receipt.state !== 'completed' || trace?.status !== 'completed' || failure) {
          throw new Error(failure ?? describeNativeFailure(receipt, trace, native.usage));
        }
        status = 'completed';
      } catch (failure) {
        error = timedOut ? 'Native trial deadline exceeded' : failure instanceof Error ? failure.message : String(failure);
        status = cancellation.signal.aborted && !timedOut ? 'cancelled' : 'failed';
        if (!blocked) await stop();
        try {
          native = await collectNativeEvidence(agent.runtimeHomePath, usageFile, agent.id, executionId, agent.engine.model!, others(), source);
        } catch (collectionError) { blocked = undefined; await stop(); error += `; evidence collection failed: ${String(collectionError)}`; }
      } finally { clearTimeout(timer); }
      const continuing = gate.finish(executionId, blocked === 'awaiting-external-input');
      if (blocked && !continuing) await stop();
      const result: TerminalEvidence = { schema: 'paideia.daimon-native.trial.v1', trialId: options.trialId, wakeId,
        agentId: agent.id, model: agent.engine.model!, ...(grok ? { engine: 'grok' as const, reasoningEffort: grok.agent.reasoningEffort } : {}), configSha256: options.configSha256, scheduleOverride: 'disabled',
        ...(launch ? { preparation: { sourceConfigSha256: launch.sourceConfigSha256, instructions: launch.instructions, overrides: launch.overrides } } : {}),
        status, startedAt, completedAt: new Date().toISOString(), executionId, receipt, activity, availability, native,
        ...(blocked ? { blocked } : {}),
        coverage: [{ channel: 'tools', completeness: native.toolReceipts.length || native.traces.some(trace => trace.tools.length) ? 'partial' : 'absent', ordering: 'none' },
          { channel: 'output', completeness: 'absent', ordering: 'none' },
          { channel: 'usage', completeness: native.accounting?.coverage ?? nativeUsageCoverage(native, executionId), ordering: 'source' }],
        ...(error ? { error } : {}) };
      // This wake's own frame first, under a name no other delivery of this trial
      // writes, then the trial's latest frame. A trial that defers runs several
      // wakes and each one's account is evidence about that wake: renaming over one
      // file had the continuation's frame replace an assignment that really bound,
      // and the earlier account no longer existed by the time anything read it.
      await writeEvidence(wakeEvidenceFile(options.evidence, ordinal), result);
      await writeEvidence(options.evidence, result);
      return result;
    },
  };
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, { once: true });
  });
}
