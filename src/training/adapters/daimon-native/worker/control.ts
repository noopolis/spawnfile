import { createDeliveryGate, type DeliveryControls } from './deliveries.js';
import { dirname, join } from 'node:path';
import { collectNativeEvidence, nativeUsageCoverage, readClosedTraces, writeEvidence } from './evidence.js';
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

function deferredAfterCompletion(receipt: NativeReceipt, trace: NativeTrace | undefined): boolean {
  return receipt.state === 'accepted' && receipt.deferred === true && trace?.status === 'completed';
}

export function describeNativeFailure(receipt: NativeReceipt, trace: NativeTrace | undefined, usage: readonly NativeUsage[] = []): string {
  if (deferredAfterCompletion(receipt, trace)) return 'Native execution completed; delivery blocked awaiting external input';
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

export function executionClosed(activity: NativeActivity, receipt: NativeReceipt, traces: NativeEvidence['traces'],
  agentId: string): string | undefined {
  if (!Array.isArray(activity.executions)) throw new Error('Native activity omitted execution authority');
  if (activity.executions.some(row => row.agent_id !== agentId)) throw new Error('Unexpected native agent execution');
  if (activity.executions.length > 0) return undefined;
  if (traces.length > 1) throw new Error('An isolated trial produced multiple native executions');
  const trace = traces[0];
  if (!trace) return undefined;
  if (trace.agent_id !== agentId || receipt.agent_id !== agentId ||
      receipt.execution_id !== undefined && receipt.execution_id !== trace.turn_id) throw new Error('Native execution evidence identity mismatch');
  return trace.turn_id;
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
      const previous = [...gate.executions];
      const startedAt = new Date().toISOString();
      const deliveryId = `${options.trialId}:${wakeId}`;
      let receipt: NativeReceipt | undefined;
      let activity: NativeActivity | undefined;
      let availability: NativeAvailability | undefined;
      let executionId: string | undefined;
      let status: TerminalEvidence['status'];
      let error: string | undefined;
      let blocked: TerminalEvidence['blocked'];
      let native: NativeEvidence = { traces: [], usage: [], toolReceipts: [], modelContexts: [] };
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; void stop(); }, remaining);
      try {
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
          if (!activity.executions.length) {
            const traces = await readClosedTraces(agent.runtimeHomePath, agent.id);
            executionId = executionClosed(activity, receipt, traces.filter(trace => !previous.includes(trace.turn_id)), agent.id);
            if (executionId) {
              receipt = await owned(host.wakeReceipt(token, accepted.acceptance_id));
              activity = await owned(host.activityV2(token));
              availability = await owned(host.availability(token));
              if (!receipt || !activity || !availability) throw new Error('Authenticated terminal control evidence disappeared');
              executionId = executionClosed(activity, receipt, traces.filter(trace => !previous.includes(trace.turn_id)), agent.id);
              if (executionId) break;
            }
            const failure = availability.agents.find(row => row.agent_id === agent.id)?.error;
            if (failure) throw new Error(`Native execution failed before terminal telemetry: ${failure}`);
            // Budget snapshots can pause immediately after this execution was admitted.
            // Only its closed trace or the bounded deadline can establish completion.
          }
          await pause(100, cancellation.signal);
        }
        native = await collectNativeEvidence(agent.runtimeHomePath, usageFile, agent.id, executionId, agent.engine.model!, previous, source);
        const trace = native.traces[0];
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
          native = await collectNativeEvidence(agent.runtimeHomePath, usageFile, agent.id, executionId, agent.engine.model!, previous, source);
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
          { channel: 'usage', completeness: nativeUsageCoverage(native, executionId), ordering: 'source' }],
        ...(error ? { error } : {}) };
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
