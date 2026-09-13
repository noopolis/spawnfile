import { runProcess, type ProcessResult, type RunningProcess } from '../platform/process/index.js';
import { verifyDspyResult } from './evidence.js';
import { DspyHost } from './host.js';
import { DSPY_SCHEMA, decodeMessage, encodeMessage, startSchema, type DspyResult } from './protocol.js';
import { DspyOptimizationError, type DspyOptimizationOptions } from './types.js';

const optionKeys = new Set(['id', 'components', 'trainCaseIds', 'validationCaseIds', 'budget', 'seed',
  'bridge', 'validateComponents', 'evaluate', 'generate', 'signal']);

/** The bridge has no credential/provider environment; inference remains in host callbacks. */
export function dspyEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { LANG: 'C.UTF-8', PYTHONNOUSERSITE: '1', PYTHONUNBUFFERED: '1' };
  for (const key of ['PATH', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

export async function runDspyOptimization(options: DspyOptimizationOptions): Promise<DspyResult> {
  if (Object.keys(options).some((key) => !optionKeys.has(key))) throw new Error('Unknown optimizer option; sealed-test data is not accepted');
  if (!Number.isFinite(options.bridge.timeoutMs) || options.bridge.timeoutMs <= 0) throw new Error('DSPy timeout must be positive');
  const start = startSchema.parse({ schema: DSPY_SCHEMA, kind: 'optimize', id: options.id,
    components: options.components, trainCaseIds: options.trainCaseIds, validationCaseIds: options.validationCaseIds,
    budget: options.budget, seed: options.seed });
  const startLine = encodeMessage(start);
  const controller = new AbortController();
  const signal = options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal]);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.bridge.timeoutMs);
  const host = new DspyHost(start, options);
  let running: RunningProcess | undefined;
  let processResult: ProcessResult | undefined;
  let terminal: DspyResult | undefined;
  let protocolFailure: Error | undefined;
  try {
    await host.validate(start.components, signal);
    signal.throwIfAborted();
    running = runProcess({ command: options.bridge.command, args: options.bridge.args ?? [],
      cwd: options.bridge.cwd, env: dspyEnvironment(), stdin: startLine,
      keepStdinOpen: true, requireLineTerminator: true,
      closureDrainMs: options.bridge.closureDrainMs, maxBytes: options.bridge.maxBytes ?? 64 * 1024 * 1024,
      timeoutMs: options.bridge.timeoutMs, signal,
      onLine: async (line, callbackSignal) => {
        try {
          if (terminal !== undefined) throw new Error('DSPy emitted data after its terminal result');
          const message = decodeMessage(line);
          if (message.kind === 'error') throw new Error(`DSPy bridge ${message.error.code}: ${message.error.message}`);
          if (message.kind === 'result') {
            terminal = message;
            running!.endInput();
            return;
          }
          const callbackAbort = AbortSignal.any([signal, callbackSignal]);
          const result = await host.handle(message, callbackAbort);
          callbackAbort.throwIfAborted();
          await running!.write(encodeMessage({ schema: DSPY_SCHEMA, kind: 'response', id: message.id, result }));
        } catch (error) {
          protocolFailure = error instanceof Error ? error : new Error(String(error));
          throw protocolFailure;
        }
      },
    });
    processResult = await running.completion;
    if (protocolFailure !== undefined) throw protocolFailure;
    if (processResult.error !== undefined || processResult.cancelled || processResult.exitCode !== 0) {
      throw new Error(processResult.error ?? `DSPy bridge exited unsuccessfully (${processResult.exitCode})`);
    }
    if (terminal === undefined) throw new Error('DSPy bridge omitted its terminal optimization result');
    signal.throwIfAborted();
    await verifyDspyResult(terminal, host, signal);
    return terminal;
  } catch (error) {
    const cancelled = signal.aborted;
    controller.abort();
    const stop = await running?.stop('DSPy optimization interrupted');
    if (running !== undefined) await running.completion;
    throw new DspyOptimizationError(timedOut ? 'timeout' : cancelled ? 'cancelled' : 'optimization_failed',
      error instanceof Error ? error.message : String(error), {
        evaluations: host.evaluations, proposals: host.proposals,
        hostWork: host.pending === 0 ? 'settled' : 'incomplete', stop: stop ?? processResult?.stop,
      });
  } finally { clearTimeout(timer); }
}
