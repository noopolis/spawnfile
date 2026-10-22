import type { StopReceipt, SubjectAdapter, SubjectStart, Usage } from '../../contracts/execution.js';
import { canonicalProtectedPaths, prepareCodexEnvironment, savedCodexHome } from '../environment.js';
import { runProcess, type RunningProcess } from '../../platform/process/index.js';
import { decodeCodex } from './protocol.js';

export interface CodexOptions {
  command?: string;
  authHome?: string;
  model?: string;
  timeoutMs?: number;
  /** Injection only changes process plumbing; production uses the installed CLI. */
  process?: typeof runProcess;
}

export function createCodexAdapter(options: CodexOptions = {}): SubjectAdapter {
  return {
    id: 'codex',
    capabilities: { toolTrace: 'partial', liveObservations: true, cancellation: 'process-group',
      multiTurn: true, resources: ['instructions', 'supporting-files'],
      readIsolation: 'declared-paths', protectedPaths: true,
      isolation: 'Native workspace permission profile, network disabled, declared protected paths denied; no universal host-read isolation.' },
    async start(input) {
      if ((input.tools?.length ?? 0) > 0) throw new Error('Codex CLI fixture-tool mounting is not supported by this adapter');
      const model = input.model ?? options.model;
      if (model === undefined || model.trim().length === 0 || model.startsWith('-')) throw new Error('An explicit native Codex model is required');
      const env = await prepareCodexEnvironment(input.workspacePath, input.runtimeHomePath, savedCodexHome(options.authHome));
      const authHome = env['CODEX_HOME']!;
      const protectedPaths = await canonicalProtectedPaths(input.protectedPaths);
      let threadId: string | undefined;
      let active: RunningProcess | undefined;
      let lastProcess: RunningProcess | undefined;
      let stopped: StopReceipt | undefined;
      let stopRequested = false;
      let used = false;
      let previousUsage: Usage | null | undefined;
      const stop = async (reason: string): Promise<StopReceipt> => {
        stopRequested = true;
        const owned = active ?? lastProcess;
        stopped = owned === undefined ? {
          state: 'acknowledged', scope: 'process-group', quiescence: 'confirmed', remoteWork: 'unknown', reason,
          detail: 'No active owned process; remote effects and escaped descendants are not covered.',
        } : await owned.stop(reason);
        return stopped;
      };
      return {
        stop,
        async run(turn, signal) {
          if (stopRequested) throw new Error('Subject session is stopped');
          if (active !== undefined) throw new Error('Concurrent wakes are unsupported');
          if (used && threadId === undefined) throw new Error('Cannot resume without the native thread identity');
          const decoder = decodeCodex(input.trialId, turn.id, input.onObservation, previousUsage);
          active = (options.process ?? runProcess)({ command: options.command ?? 'codex',
            args: codexArguments({ ...input, protectedPaths }, authHome, model, threadId),
            cwd: input.workspacePath, env, stdin: turn.text, timeoutMs: options.timeoutMs ?? 180_000,
            signal: combineSignals(input.signal, signal), onLine: decoder.decode });
          used = true;
          lastProcess = active;
          try {
            const result = await active.completion;
            if (result.cancelled) stopRequested = true;
            previousUsage = decoder.cumulativeUsage;
            threadId ??= decoder.threadId;
            const error = result.error ?? decoder.failed ??
              (result.exitCode !== 0 ? `Codex exited ${result.exitCode}: ${result.stderr}` : undefined) ??
              (!decoder.completed || decoder.text.trim().length === 0 ? 'Codex did not produce a completed nonempty result' : undefined);
            if (error !== undefined) stopRequested = true;
            return {
              status: result.error !== undefined ? 'failed' as const : result.cancelled ? 'cancelled' as const : error === undefined ? 'completed' as const : 'failed' as const,
              text: decoder.text, usage: decoder.usage, error, stop: result.stop,
              coverage: [
                { channel: 'tools' as const, completeness: 'partial' as const, ordering: 'source' as const },
                { channel: 'output' as const, completeness: error === undefined ? 'complete' as const : 'partial' as const, ordering: 'source' as const },
                { channel: 'usage' as const, completeness: decoder.usage === null ? 'absent' as const : 'partial' as const, ordering: 'source' as const },
              ],
            };
          } finally { active = undefined; }
        },
      };
    },
  };
}

export function codexArguments(input: SubjectStart, authHome: string, model?: string, threadId?: string): string[] {
  const denied = [...new Set([authHome, ...(input.protectedPaths ?? [])])];
  const filesystem = [
    '":workspace_roots"={"."="write"}',
    ...denied.map((entry) => `${JSON.stringify(entry)}="deny"`),
  ].join(',');
  return ['exec', '--ignore-user-config', '--ignore-rules', '--strict-config', '--disable', 'memories',
    '--skip-git-repo-check', '--json', '-C', input.workspacePath,
    '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0',
    '-c', 'mcp_servers={}', '-c', 'default_permissions="paideia"',
    '-c', `permissions={paideia={extends=":workspace",filesystem={${filesystem}},network={enabled=false}}}`,
    '-c', `developer_instructions=${JSON.stringify(input.instructions)}`,
    ...(model === undefined ? [] : ['--model', model]),
    ...(threadId === undefined ? ['-'] : ['resume', threadId, '-'])];
}

export function combineSignals(first?: AbortSignal, second?: AbortSignal): AbortSignal | undefined {
  const signals = [first, second].filter((signal): signal is AbortSignal => signal !== undefined);
  return signals.length === 0 ? undefined : AbortSignal.any(signals);
}
