import type { SubjectAdapter } from '../../contracts/execution.js';
import type { TerminalEvidence } from './worker/index.js';
import { dockerCommand, workerRequest, type DockerCommand } from './container/index.js';
import { startOwnedContainer } from './container/index.js';
import { loadNativeLaunch } from './container/index.js';
import { createNativeObserver } from './observations.js';

export interface NativeAdapterOptions { timeoutMs?: number; startupMs?: number; docker?: DockerCommand }

export function createDaimonNativeAdapter(options: NativeAdapterOptions = {}): SubjectAdapter {
  const timeoutMs = options.timeoutMs ?? 900_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3_600_000) throw new Error('Invalid native adapter deadline');
  const docker = options.docker ?? dockerCommand();
  return {
    id: 'daimon-native',
    capabilities: { toolTrace: 'partial', liveObservations: true, cancellation: 'native-handle', multiTurn: false,
      resources: ['instructions', 'supporting-files'], readIsolation: 'declared-paths', protectedPaths: true,
      isolation: 'Fresh local Linux container; canonical native sandbox denies /run and runtime credentials; evaluator files excluded from mounts' },
    async start(input) {
      if (input.signal?.aborted) throw new Error('Native subject start aborted');
      const launch = await loadNativeLaunch(input);
      const container = await startOwnedContainer(docker, launch, input.trialId, timeoutMs, input.signal, options.startupMs);
      const observer = createNativeObserver(input, launch.projections.find(row => row.role === 'home')!.source, launch.agent.id);
      let used = false;
      let stopped = false;
      const stop = async (reason: string) => { stopped = true; return container.stop(reason); };
      return {
        stop,
        async run(turn, signal) {
          if (used || stopped) throw new Error('Native Daimon session permits one delivery');
          used = true;
          const signals = [input.signal, signal].filter((value): value is AbortSignal => value !== undefined);
          const cancelled = new AbortController();
          const abort = (): void => { cancelled.abort(); void stop('Native subject aborted'); };
          for (const source of signals) source.addEventListener('abort', abort, { once: true });
          if (signals.some(source => source.aborted)) abort();
          let done = false;
          let terminal: TerminalEvidence | undefined;
          let failure: unknown;
          const response = workerRequest<TerminalEvidence>(docker, container.name, '/trial/run', { wakeId: turn.id, text: turn.text },
            timeoutMs + 8000, cancelled.signal, launch.host.port).then(value => { terminal = value; }, error => { failure = error; }).finally(() => { done = true; });
          try {
            while (!done) {
              await observer.checkpoint(turn.id);
              await Promise.race([response, new Promise(resolve => setTimeout(resolve, 200))]);
            }
            if (failure) throw failure;
            if (!terminal || terminal.schema !== 'paideia.daimon-native.trial.v1' || terminal.trialId !== input.trialId ||
                terminal.wakeId !== turn.id || terminal.agentId !== launch.agent.id || terminal.model !== launch.agent.model ||
                terminal.configSha256 !== launch.configSha256) throw new Error('Native terminal evidence identity mismatch');
            await observer.checkpoint(turn.id);
            const usage = await observer.terminal(turn.id, terminal);
            return { status: terminal.status, text: '', usage, error: terminal.error, coverage: terminal.coverage };
          } catch (error) {
            cancelled.abort();
            const receipt = await stop('Native subject execution failed');
            return { status: signals.some(source => source.aborted) ? 'cancelled' as const : 'failed' as const,
              text: '', usage: null, error: String(error), stop: receipt,
              coverage: [{ channel: 'tools' as const, completeness: 'partial' as const, ordering: 'none' as const },
                { channel: 'output' as const, completeness: 'absent' as const, ordering: 'none' as const },
                { channel: 'usage' as const, completeness: 'absent' as const, ordering: 'none' as const }] };
          } finally { for (const source of signals) source.removeEventListener('abort', abort); }
        },
      };
    },
  };
}
