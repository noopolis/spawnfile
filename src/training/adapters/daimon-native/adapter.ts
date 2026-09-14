import { nextExternalInput, sumNativeUsage, weakestNativeCoverage, type NativeExternalInputs } from './external.js';
import type { SubjectAdapter, Usage, SubjectTurnResult } from '../../contracts/execution.js';
import type { TerminalEvidence, DeliveryControls } from './worker/index.js';
import { dockerCommand, workerRequest, type DockerCommand } from './container/index.js';
import { startOwnedContainer } from './container/index.js';
import { loadNativeLaunch } from './container/index.js';
import { createNativeObserver } from './observations.js';

export interface NativeAdapterOptions { timeoutMs?: number; startupMs?: number; docker?: DockerCommand; externalInputs?: NativeExternalInputs }

export function createDaimonNativeAdapter(options: NativeAdapterOptions = {}): SubjectAdapter {
  const timeoutMs = options.timeoutMs ?? 900_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3_600_000) throw new Error('Invalid native adapter deadline');
  const external = options.externalInputs;
  if (external && (!Number.isSafeInteger(external.maxDeliveries) || external.maxDeliveries < 1 || external.maxDeliveries > 3 || typeof external.next !== 'function')) throw new Error('Invalid external input policy');
  const docker = options.docker ?? dockerCommand();
  return {
    id: 'daimon-native',
    capabilities: { toolTrace: 'partial', liveObservations: true, cancellation: 'native-handle', multiTurn: false,
      resources: ['instructions', 'supporting-files'], readIsolation: 'declared-paths', protectedPaths: true,
      isolation: 'Fresh local Linux container; canonical native sandbox denies /run and runtime credentials; evaluator files excluded from mounts' },
    async start(input) {
      if (input.signal?.aborted) throw new Error('Native subject start aborted');
      const launch = await loadNativeLaunch(input);
      const deadline = Date.now() + timeoutMs;
      const container = await startOwnedContainer(docker, launch, input.trialId, timeoutMs, input.signal, options.startupMs);
      const observer = createNativeObserver(input, launch.projections.find(row => row.role === 'home')!.source, launch.agent.id);
      let used = false;
      let stopped = false;
      const stop = async (reason: string) => { stopped = true; return container.stop(reason); };
      const deliver = async (turn: {id: string; text: string}, signal: AbortSignal | undefined, controls?: DeliveryControls, observedWakeId = turn.id) => {
          const signals = [input.signal, signal].filter((value): value is AbortSignal => value !== undefined);
          const cancelled = new AbortController();
          const abort = (): void => { cancelled.abort(); void stop('Native subject aborted'); };
          for (const source of signals) source.addEventListener('abort', abort, { once: true });
          if (signals.some(source => source.aborted)) abort();
          let done = false;
          let terminal: TerminalEvidence | undefined;
          let failure: unknown;
          const response = workerRequest<TerminalEvidence>(docker, container.name, '/trial/run', { wakeId: turn.id, text: turn.text, ...(controls ? { controls } : {}) },
            Math.max(1, deadline - Date.now()) + 8000, cancelled.signal, launch.host.port).then(value => { terminal = value; }, error => { failure = error; }).finally(() => { done = true; });
          try {
            while (!done) {
              await observer.checkpoint(observedWakeId);
              await Promise.race([response, new Promise(resolve => setTimeout(resolve, 200))]);
            }
            if (failure) throw failure;
            if (!terminal || terminal.schema !== 'paideia.daimon-native.trial.v1' || terminal.trialId !== input.trialId ||
                terminal.wakeId !== turn.id || terminal.agentId !== launch.agent.id || terminal.model !== launch.agent.model ||
                terminal.configSha256 !== launch.configSha256) throw new Error('Native terminal evidence identity mismatch');
            if (terminal.blocked && terminal.status !== 'failed') throw new Error('Blocked native terminal cannot claim completion');
            await observer.checkpoint(observedWakeId);
            const usage = await observer.terminal(observedWakeId, terminal);
            return { result: { status: terminal.status, text: '', usage, error: terminal.error, coverage: terminal.coverage } as SubjectTurnResult, terminal, verified: true };
          } catch (error) {
            cancelled.abort();
            const receipt = await stop('Native subject execution failed');
            return { result: { status: signals.some(source => source.aborted) ? 'cancelled' as const : 'failed' as const,
              text: '', usage: null, error: String(error), stop: receipt,
              coverage: [{ channel: 'tools' as const, completeness: 'partial' as const, ordering: 'none' as const },
                { channel: 'output' as const, completeness: 'absent' as const, ordering: 'none' as const },
                { channel: 'usage' as const, completeness: 'absent' as const, ordering: 'none' as const }] } as SubjectTurnResult, terminal, verified: false };
          } finally { for (const source of signals) source.removeEventListener('abort', abort); }
      };
      return { stop, async run(turn, signal) {
        if (used || stopped) throw new Error('Native Daimon session permits one delivery');
        used = true;
        const combined = AbortSignal.any([input.signal, signal].filter((value): value is AbortSignal => value !== undefined));
        const usages: (Usage | null)[] = [];
        const coverages: SubjectTurnResult['coverage'][] = [];
        const ids = new Set([turn.id]);
        let current = turn;
        let controls: DeliveryControls | undefined = external ? { maxExternalDeliveries: external.maxDeliveries } : undefined;
        try {
          for (let ordinal = 0; ; ordinal++) {
            const { result, terminal, verified } = await deliver(current, combined, controls, turn.id);
            usages.push(result.usage);
            coverages.push(result.coverage);
            if (!verified || stopped || !external || terminal?.blocked !== 'awaiting-external-input') return { ...result, usage: sumNativeUsage(usages), coverage: weakestNativeCoverage(coverages) };
            if (ordinal >= external.maxDeliveries) return { ...result, status: 'failed', usage: sumNativeUsage(usages), coverage: weakestNativeCoverage(coverages), stop: await stop('External input delivery budget exhausted') };
            const next = await nextExternalInput(external, { trialId: input.trialId, turnId: turn.id, containerName: container.name, launch, terminal }, deadline, combined);
            if (!next) return { ...result, status: 'failed', usage: sumNativeUsage(usages), coverage: weakestNativeCoverage(coverages), stop: await stop('No matching external input') };
            if (ids.has(next.id)) throw new Error('External input delivery ID was reused');
            ids.add(next.id);
            await observer.externalInput(turn.id, next);
            current = { id: next.id, text: next.text };
            controls = { source: next.source };
          }
        } catch (error) {
          const receipt = await stop('External input continuation failed');
          return { status: combined.aborted ? 'cancelled' : 'failed', text: '', usage: sumNativeUsage(usages), error: String(error), stop: receipt,
            coverage: weakestNativeCoverage(coverages) };
        }
      } };
    },
  };
}
