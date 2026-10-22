import { describeNativeFailure, executionClosed, claimedExecution, disposedWakeExecution, deferredAfterCompletion, declaredLimitStop, DeclaredLimitStop } from './evidence/index.js';
export { describeNativeFailure, admittedExecutions, validateNativeFrame, executionClosed, claimedExecution, disposedWakeExecution, AMBIGUOUS_NATIVE_EXECUTION, AMBIGUOUS_WAKE_EXECUTION } from './evidence/index.js';
import { createDeliveryGate, engineWakeTimeoutMs, type DeliveryControls } from './deliveries.js';
import { dirname, join } from 'node:path';
import { collectNativeEvidence, nativeUsageCoverage, readClosedTraces, wakeEvidenceFile, writeEvidence, settleNativeRead } from './evidence/index.js';
import { isGrokLaunch, type NativeLaunch, type NativeTaskClockEvidence } from '../receipt/index.js';
import { createTransportDelivery, parseTransportSource, validateTransportExecutions, type TransportDeliverySource } from './wake-delivery/index.js';
import type { NativeActivity, NativeAvailability, NativeConfig, NativeEvidence, NativeEvidenceSource, NativeHost,
  NativeReceipt, TerminalEvidence, WorkerOptions } from './types.js';

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
  transport?: ReturnType<typeof createTransportDelivery>;
  run(wakeId: string, text: string, controls?: DeliveryControls, source?: TransportDeliverySource): Promise<TerminalEvidence>;
  stop(): Promise<NativeStopEvidence>;
}

export function createWorkerController(host: NativeHost, config: NativeConfig, options: WorkerOptions,
  token: string, launch?: NativeLaunch, taskClock?: NativeTaskClockEvidence): WorkerController {
  const observation = {
    wakeReceipt: (auth: string | undefined, id: string) => settleNativeRead('wake acceptance receipt', () => host.wakeReceipt(auth, id)),
    activityV2: (auth: string | undefined) => settleNativeRead('activity acceptance/batch snapshot', () => host.activityV2(auth)),
    availability: (auth: string | undefined) => settleNativeRead('availability snapshot', () => host.availability(auth)),
  };
  const agent = config.agents[0]!;
  if (agent.engine.kind === 'grok' && (!launch || !isGrokLaunch(launch))) throw new Error('Grok native trials require their Grok broker launch receipt');
  const grok = launch && isGrokLaunch(launch) ? launch : undefined;
  const usageFile = grok ? grok.broker.usageLedgerPath : join(options.controlRoot, 'usage.jsonl');
  const source: NativeEvidenceSource = grok ? { engine: 'grok', requestsFile: join(dirname(usageFile), 'requests.jsonl') } : { engine: 'codex' };
  const cancellation = new AbortController();
  const gate = createDeliveryGate(options.timeoutMs, agent.attention?.maxExecutions, launch?.delivery);
  const wakeTimeoutMs = engineWakeTimeoutMs(options.timeoutMs, launch);
  const transport = launch?.delivery === 'transport' ? createTransportDelivery(host, agent.id) : undefined;
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
    // The HTTP observation routes used by child closure share the same readers.
    host: { start: () => host.start(), stop: () => host.stop(), health: () => host.health(),
      accept: value => host.accept(value), ...observation }, stop, ...(transport ? { transport } : {}),
    async run(wakeId, text, controls, expectedSource) {
      if (cancellation.signal.aborted) throw new Error('Worker accepts exactly one native trial delivery');
      const remaining = gate.begin(wakeId, text, controls, expectedSource);
      const incoming = transport?.begin(wakeId, parseTransportSource(expectedSource));
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
      let deliveryId = `${options.trialId}:${wakeId}`;
      let receipt: NativeReceipt | undefined;
      let activity: NativeActivity | undefined;
      let availability: NativeAvailability | undefined;
      /** The execution the runtime bound to this delivery, once it has said which. */
      let claimed: string | undefined;
      let executionId: string | undefined;
      let status: TerminalEvidence['status'];
      let error: string | undefined;
      let blocked: TerminalEvidence['blocked'];
      let limit: TerminalEvidence['limit'];
      let native: NativeEvidence = { traces: [], usage: [], toolReceipts: [], modelContexts: [] };
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; void stop(); }, remaining);
      try {
        // Whatever this trial had already closed before this delivery existed. The
        // runtime home is asserted empty at startup and every trace in it is refused
        // unless it is this agent's, so the rows here are this trial's earlier wakes
        // by construction rather than by counting.
        for (const trace of await owned(readClosedTraces(agent.runtimeHomePath, agent.id))) history.add(trace.turn_id);
        const accepted = incoming ? await owned(incoming.accepted) : await owned(host.accept({ token, agent_id: agent.id, delivery_id: deliveryId,
          event: { version: 'noopolis.daimon.wake.v2', kind: 'manual', text, occurred_at: startedAt } }));
        if (accepted.state !== 'accepted') throw new Error(`Native acceptance refused: ${accepted.code}`);
        if (incoming) deliveryId = incoming.evidence.deliveryId!;
        for (;;) {
          // Capture admission before any asynchronous snapshot/collection. A route
          // request that enters or settles meanwhile requires another full pass.
          const generation = incoming?.generation();
          while (true) {
            if (cancellation.signal.aborted) throw new Error(timedOut ? 'Native trial deadline exceeded' : 'Native trial cancelled');
            [receipt, activity, availability] = await owned(Promise.all([
              observation.wakeReceipt(token, accepted.acceptance_id), observation.activityV2(token), observation.availability(token),
            ]));
            if (!receipt || !activity || !availability) throw new Error('Authenticated native control evidence disappeared');
            if (receipt.delivery_id !== deliveryId || receipt.agent_id !== agent.id) throw new Error('Native receipt identity mismatch');
            if (!Array.isArray(activity.executions)) throw new Error('Native activity omitted execution authority');
            // The runtime's own binding of this delivery to an execution, and its own
            // account of everything else it is running for this trial meanwhile.
            claimed = claimedExecution(receipt, activity, deliveryId, agent.id) ?? claimed;
            incoming?.observe(receipt, activity, availability, claimed);
            for (const row of activity.executions) if (row.agent_id === agent.id) history.add(row.execution_id);
            if (!activity.executions.length) {
              const traces = await readClosedTraces(agent.runtimeHomePath, agent.id, claimed !== undefined);
              // The runtime's own binding first; only for a delivery it has disposed
              // of, on a runtime admitting nothing, may this wake answer for the
              // execution that closed inside its own window instead.
              if (!incoming) claimed ??= disposedWakeExecution(receipt, traces, history);
              if (claimed) {
                executionId = executionClosed(activity, receipt, traces, agent.id, claimed);
                if (executionId) {
                  receipt = await owned(observation.wakeReceipt(token, accepted.acceptance_id));
                  activity = await owned(observation.activityV2(token));
                  availability = await owned(observation.availability(token));
                  if (!receipt || !activity || !availability) throw new Error('Authenticated terminal control evidence disappeared');
                  if (receipt.delivery_id !== deliveryId) throw new Error('Native receipt identity mismatch');
                  incoming?.observe(receipt, activity, availability, claimed);
                  executionId = executionClosed(activity, receipt, traces, agent.id, claimed);
                  if (executionId && (!incoming || incoming.closed(traces))) break;
                }
              }
              const failure = availability.agents.find(row => row.agent_id === agent.id)?.error;
              if (failure) throw new Error(`Native execution failed before terminal telemetry: ${failure}`);
              // Budget snapshots can pause immediately after this execution was admitted.
              // Only its closed trace or the bounded deadline can establish completion.
            }
            await pause(100, cancellation.signal);
          }
          native = await owned(collectNativeEvidence(agent.runtimeHomePath, usageFile, agent.id,
            incoming ? undefined : executionId, agent.engine.model!, incoming ? [] : others(), source));
          if (cancellation.signal.aborted) throw new Error('Native trial cancelled');
          if (incoming) {
            // Synchronously seal against route admission before deciding a terminal
            // outcome. No in-flight acceptance can be omitted by this snapshot.
            if (!incoming.seal(generation!, native.traces)) { await pause(100, cancellation.signal); continue; }
            validateTransportExecutions(incoming.evidence, native, activity, agent.id, wakeTimeoutMs);
          }
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
          if (!failure && trace?.status === 'completed' && incoming?.evidence.deferredDeliveryIds.length) {
            blocked = 'awaiting-external-input';
            throw new Error('Native execution completed; transport batch deliveries blocked awaiting external input');
          }
          if (incoming?.evidence.unresolvedDeliveryIds.length) throw new Error('Transport trial deliveries remain unresolved');
          if (!failure && deferredAfterCompletion(receipt, trace)) blocked = 'awaiting-external-input';
          if (receipt.state !== 'completed' || trace?.status !== 'completed' || failure) {
            // The closed execution's own sealed limit row outranks the runtime's
            // generic availability error, which that same limit is what raised.
            const limit = declaredLimitStop(trace, native.usage, wakeTimeoutMs);
            if (limit) throw new DeclaredLimitStop(limit, describeNativeFailure(receipt, trace, native.usage));
            throw new Error(failure ?? describeNativeFailure(receipt, trace, native.usage));
          }
          status = 'completed';
          break;
        }
      } catch (failure) {
        error = timedOut ? incoming && !incoming.evidence.deliveryId ? 'Transport delivery deadline exceeded: no matching delivery arrived'
          : 'Native trial deadline exceeded' : failure instanceof Error ? failure.message : String(failure);
        status = cancellation.signal.aborted && !timedOut ? 'cancelled' : 'failed';
        // Thrown only synchronously after the cancellation check, so a deadline or abort never carries it.
        if (failure instanceof DeclaredLimitStop) limit = failure.limit;
        if (!blocked) await stop();
        try {
          native = await collectNativeEvidence(agent.runtimeHomePath, usageFile, agent.id,
            incoming ? undefined : executionId, agent.engine.model!, incoming ? [] : others(), source);
        } catch (collectionError) { blocked = undefined; limit = undefined; await stop(); error += `; evidence collection failed: ${String(collectionError)}`; }
      } finally { clearTimeout(timer); incoming?.finish(); }
      const continuing = gate.finish(executionId, blocked === 'awaiting-external-input');
      if (blocked && !continuing) await stop();
      const result: TerminalEvidence = { schema: 'paideia.daimon-native.trial.v1', trialId: options.trialId, wakeId,
        agentId: agent.id, model: agent.engine.model!, ...(grok ? { engine: 'grok' as const, reasoningEffort: grok.agent.reasoningEffort } : {}), configSha256: options.configSha256, scheduleOverride: 'disabled',
        ...(launch ? { preparation: { sourceConfigSha256: launch.sourceConfigSha256, instructions: launch.instructions, overrides: launch.overrides } } : {}),
        ...(incoming ? { transport: incoming.evidence } : {}), ...(taskClock ? { taskClock } : {}),
        status, startedAt, completedAt: new Date().toISOString(), executionId, receipt, activity, availability, native,
        ...(blocked ? { blocked } : {}), ...(limit ? { limit } : {}),
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
