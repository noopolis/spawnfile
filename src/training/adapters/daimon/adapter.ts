import path from 'node:path';
import type { Observation, StopReceipt, SubjectAdapter, Usage } from '../../contracts/execution.js';
import { canonicalProtectedPaths, prepareCodexEnvironment, savedCodexHome } from '../environment.js';
import { loadDaimon, type DaimonModule, type NativeTool } from './public.js';

export interface DaimonOptions {
  command?: string;
  authHome?: string;
  model?: string;
  timeoutMs?: number;
  stopTimeoutMs?: number;
  load?: () => Promise<DaimonModule>;
}

export function createDaimonAdapter(options: DaimonOptions = {}): SubjectAdapter {
  return {
    id: 'daimon',
    capabilities: { toolTrace: 'partial', liveObservations: true, cancellation: 'native-handle',
      multiTurn: false, resources: ['instructions', 'supporting-files'],
      readIsolation: 'declared-paths', protectedPaths: true,
      isolation: 'Daimon strict Codex profile; host fixture journal only; native stop acknowledgement has unverified remote scope.' },
    async start(input) {
      const timeoutMs = options.timeoutMs ?? 180_000;
      const stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
      if (![timeoutMs, stopTimeoutMs].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error('Daimon timeouts must be positive integers');
      const model = input.model ?? options.model;
      if (model === undefined || model.trim().length === 0 || model.startsWith('-')) throw new Error('An explicit native Daimon model is required');
      const env = await prepareCodexEnvironment(input.workspacePath, input.runtimeHomePath, savedCodexHome(options.authHome));
      const authHome = env['CODEX_HOME']!;
      const protectedPaths = await canonicalProtectedPaths(input.protectedPaths);
      const native = await (options.load ?? loadDaimon)();
      if (native.PiHarnessAdapter.capabilities?.causalRunId !== true) {
        throw new Error('Installed Daimon lacks per-instance causal run context');
      }
      const probe = native.renderCodexArgs({ codexProjectDocMaxBytes: 0,
        codexSandbox: { mode: 'workspace-write', networkAccess: false, webSearch: 'disabled' } },
      input.workspacePath, 'http://127.0.0.1:1/mcp');
      if (!probe.includes('project_doc_max_bytes=0')) {
        throw new Error('Installed Daimon cannot disable ambient Codex instruction discovery');
      }
      let seq = 0;
      let wakeId = '';
      let used = false;
      let usage: Usage | null = null;
      let stopping: Promise<StopReceipt> | undefined;
      let observationFailure: Error | undefined;
      let interrupted!: () => void;
      const interruption = new Promise<void>((resolve) => { interrupted = resolve; });
      const source = `daimon-fixtures:${input.trialId}`;
      const emit = async (value: Partial<Observation> & Pick<Observation, 'type'>): Promise<string> => {
        const id = `${source}:${++seq}`;
        try {
          await input.onObservation({ id, source, seq, trialId: input.trialId, wakeId,
            timestamp: new Date().toISOString(), ...value });
        } catch (error) {
          observationFailure = error instanceof Error ? error : new Error(String(error));
          void stop('observation sink failed');
          throw observationFailure;
        }
        return id;
      };
      const tools: NativeTool[] = (input.tools ?? []).map((tool) => ({
        name: tool.name, label: tool.name, description: tool.description, parameters: tool.parameters,
        async execute(callId, args, signal) {
          const parent = await emit({ type: 'tool.dispatch', callId, tool: tool.name, args });
          let result: unknown;
          try {
            if (stopping !== undefined || signal?.aborted === true) throw new Error('Tool cancelled before execution');
            result = await tool.execute(args, signal);
          } catch (error) {
            await emit({ type: 'tool.complete', callId, tool: tool.name, args,
              result: error instanceof Error ? error.message : String(error), success: false, causalParents: [parent] });
            throw error;
          }
          await emit({ type: 'tool.complete', callId, tool: tool.name, args, result, success: true, causalParents: [parent] });
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
        },
      }));
      const sessionFactory = native.createCliSessionFactory({ engine: 'codex',
        command: options.command, engineHomePath: authHome, model,
        identityPrompt: input.instructions, timeoutMs,
        codexSandbox: { mode: 'workspace-write', networkAccess: false, webSearch: 'disabled' },
        codexSandboxProtectedPaths: [authHome, ...protectedPaths],
        codexSandboxReadablePaths: [input.runtimeHomePath],
        codexProjectDocMaxBytes: 0,
        onTurnUsage: async (value: Record<string, unknown>) => {
          const count = (key: string): number | null => typeof value[key] === 'number' ? value[key] as number : null;
          usage = { inputTokens: count('input'), cachedInputTokens: count('cacheRead'), outputTokens: count('output'),
            reasoningTokens: null, source: 'daimon.codex.onTurnUsage' };
          await emit({ type: 'usage', usage });
        },
      });
      const harness = new native.PiHarnessAdapter({
        // Empty native Pi registry; saved subscription stays in Codex's external auth home.
        authPath: path.join(input.runtimeHomePath, 'unused-pi-auth.json'),
        model: { provider: 'openai', name: model, auth: { method: 'codex' } },
        sessionFactory, toolNames: [], productionTools: tools,
      });
      const handle = await harness.startAgent({ id: input.trialId, name: 'Paideia subject', instructions: input.instructions,
        causalRunId: input.trialId,
        workspacePath: input.workspacePath, runtimeHomePath: input.runtimeHomePath, tools: [] });
      const stop = (reason: string): Promise<StopReceipt> => {
        stopping ??= (async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const acknowledged = await Promise.race([
              Promise.resolve().then(async () => { await handle.stop(); return true; }),
              new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), stopTimeoutMs); }),
            ]);
            if (!acknowledged) throw new Error('Native stop acknowledgement deadline exceeded');
            return { state: handle.status().state === 'stopped' ? 'acknowledged' as const : 'unknown' as const,
              scope: 'native-handle' as const, quiescence: 'unknown' as const, remoteWork: 'unknown' as const, reason,
              detail: 'Daimon stop returned; Paideia cannot independently inspect its owned process groups or remote fixture effects.' };
          } catch (error) {
            return { state: 'unknown' as const, scope: 'native-handle' as const, quiescence: 'unknown' as const,
              remoteWork: 'unknown' as const, reason, detail: `Native stop failed: ${String(error)}` };
          } finally { clearTimeout(timer); interrupted(); }
        })();
        return stopping;
      };
      return {
        stop,
        async run(turn, signal) {
          if (used) throw new Error('This Daimon CLI route has no cross-wake conversation contract');
          if (stopping !== undefined) throw new Error('Subject session is stopped');
          used = true;
          wakeId = turn.id;
          const abort = (): void => { void stop('abort signal'); };
          const signals = [input.signal, signal].filter((entry): entry is AbortSignal => entry !== undefined);
          for (const entry of signals) entry.addEventListener('abort', abort, { once: true });
          let text = '';
          let error: string | undefined;
          let timedOut = false;
          const deadline = setTimeout(() => { timedOut = true; void stop('native wake deadline'); }, timeoutMs);
          try {
            if (signals.some((entry) => entry.aborted)) { abort(); throw new Error('Aborted before wake'); }
            const result = await Promise.race([
              handle.wake({ id: turn.id, kind: 'manual', text: turn.text }),
              interruption.then(() => { throw new Error('Native wake interrupted before terminal completion'); }),
            ]);
            text = result.text;
            if (text.trim().length === 0) throw new Error('Daimon returned no final output');
            if (observationFailure !== undefined) throw observationFailure;
            await emit({ type: 'output', text });
          } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
          finally { clearTimeout(deadline); for (const entry of signals) entry.removeEventListener('abort', abort); }
          const receipt = stopping === undefined ? undefined : await stopping;
          return { status: observationFailure !== undefined || timedOut ? 'failed' as const : receipt === undefined ? error === undefined ? 'completed' as const : 'failed' as const : 'cancelled' as const,
            text, usage, error, stop: receipt,
            coverage: [
              { channel: 'tools' as const, completeness: tools.length === 0 ? 'absent' as const : 'partial' as const, ordering: 'causal' as const },
              { channel: 'output' as const, completeness: error === undefined ? 'complete' as const : 'partial' as const, ordering: 'source' as const },
              { channel: 'usage' as const, completeness: usage === null ? 'absent' as const : 'partial' as const, ordering: 'source' as const },
            ] };
        },
      };
    },
  };
}
