import { join } from 'node:path';
import { collectNativeEvidence, readClosedTraces, writeEvidence } from './evidence.js';
import type { NativeLaunch } from '../receipt/index.js';
import type { NativeActivity, NativeAvailability, NativeConfig, NativeEvidence, NativeHost,
  NativeReceipt, NativeTrace, TerminalEvidence, WorkerOptions } from './types.js';

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
  run(wakeId: string, text: string): Promise<TerminalEvidence>;
  stop(): Promise<NativeStopEvidence>;
}

function deferredAfterCompletion(receipt: NativeReceipt, trace: NativeTrace | undefined): boolean {
  return receipt.state === 'accepted' && receipt.deferred === true && trace?.status === 'completed';
}

export function describeNativeFailure(receipt: NativeReceipt, trace: NativeTrace | undefined): string {
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
  const cancellation = new AbortController();
  let invoked = false;
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
    async run(wakeId, text) {
      if (invoked || cancellation.signal.aborted) throw new Error('Worker accepts exactly one native trial delivery');
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(wakeId) || !text.trim() || Buffer.byteLength(text) > 16384) {
        throw new Error('Invalid bounded trial delivery');
      }
      invoked = true;
      const startedAt = new Date().toISOString();
      const deliveryId = `${options.trialId}:${wakeId}`;
      const usageFile = join(options.controlRoot, 'usage.jsonl');
      let receipt: NativeReceipt | undefined;
      let activity: NativeActivity | undefined;
      let availability: NativeAvailability | undefined;
      let executionId: string | undefined;
      let status: TerminalEvidence['status'];
      let error: string | undefined;
      let blocked: TerminalEvidence['blocked'];
      let native: NativeEvidence = { traces: [], usage: [], toolReceipts: [], modelContexts: [] };
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; void stop(); }, options.timeoutMs);
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
            executionId = executionClosed(activity, receipt, traces, agent.id);
            if (executionId) {
              receipt = await owned(host.wakeReceipt(token, accepted.acceptance_id));
              activity = await owned(host.activityV2(token));
              availability = await owned(host.availability(token));
              if (!receipt || !activity || !availability) throw new Error('Authenticated terminal control evidence disappeared');
              executionId = executionClosed(activity, receipt, traces, agent.id);
              if (executionId) break;
            }
            const failure = availability.agents.find(row => row.agent_id === agent.id)?.error;
            if (failure) throw new Error(`Native execution failed before terminal telemetry: ${failure}`);
            // Budget snapshots can pause immediately after this execution was admitted.
            // Only its closed trace or the bounded deadline can establish completion.
          }
          await pause(100, cancellation.signal);
        }
        native = await collectNativeEvidence(agent.runtimeHomePath, usageFile, agent.id, executionId, agent.engine.model!);
        const trace = native.traces[0];
        const failure = availability.agents.find(row => row.agent_id === agent.id)?.error;
        if (!failure && deferredAfterCompletion(receipt, trace)) blocked = 'awaiting-external-input';
        if (receipt.state !== 'completed' || trace?.status !== 'completed' || failure) {
          throw new Error(failure ?? describeNativeFailure(receipt, trace));
        }
        if (!native.usage.length) throw new Error('Closed native execution omitted token usage evidence');
        if (!native.modelContexts.length) throw new Error('Closed native execution omitted model identity evidence');
        status = 'completed';
      } catch (failure) {
        error = timedOut ? 'Native trial deadline exceeded' : failure instanceof Error ? failure.message : String(failure);
        status = cancellation.signal.aborted && !timedOut ? 'cancelled' : 'failed';
        await stop();
        try {
          native = await collectNativeEvidence(agent.runtimeHomePath, usageFile, agent.id, executionId, agent.engine.model!);
        } catch (collectionError) { error += `; evidence collection failed: ${String(collectionError)}`; }
      } finally { clearTimeout(timer); }
      const result: TerminalEvidence = { schema: 'paideia.daimon-native.trial.v1', trialId: options.trialId, wakeId,
        agentId: agent.id, model: agent.engine.model!, configSha256: options.configSha256, scheduleOverride: 'disabled',
        ...(launch ? { preparation: { sourceConfigSha256: launch.sourceConfigSha256, instructions: launch.instructions, overrides: launch.overrides } } : {}),
        status, startedAt, completedAt: new Date().toISOString(), executionId, receipt, activity, availability, native,
        ...(blocked ? { blocked } : {}),
        coverage: [{ channel: 'tools', completeness: native.toolReceipts.length || native.traces.some(trace => trace.tools.length) ? 'partial' : 'absent', ordering: 'none' },
          { channel: 'output', completeness: 'absent', ordering: 'none' },
          { channel: 'usage', completeness: native.usage.length ? 'partial' : 'absent', ordering: 'source' }],
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
