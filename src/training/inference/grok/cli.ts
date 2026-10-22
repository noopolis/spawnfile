import type { InferenceRequest, InferenceResult } from '../../contracts/execution.js';
import { runProcess } from '../../platform/process/index.js';
import { captureInferenceDiagnostic } from '../diagnostic.js';
import { InferenceFailure } from '../failure.js';
import { validateInferenceResponse } from '../response-schema.js';
import { decodeGrok, grokFailureEvidence, validateGrokInitialization, type GrokAuthMode, type GrokFrames } from './protocol.js';

export type GrokReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface GrokCliRun {
  command: string;
  cwd: string;
  promptFile: string;
  /** The complete child environment; nothing else is inherited. */
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** `--model` argument: a catalog model for subscription, the pinned client model id for a grant. */
  cliModel: string;
  reasoningEffort: GrokReasoningEffort;
  request: InferenceRequest;
  responseSchema: InferenceRequest['responseSchema'];
  mode: GrokAuthMode;
  process?: typeof runProcess;
}

/** One tool-free Grok CLI call with init attestation before any further native frame is consumed. */
export async function runGrokCli(run: GrokCliRun): Promise<InferenceResult> {
  const { request, responseSchema, mode } = run;
  const frames: GrokFrames = {};
  let malformed = false;
  let nativeFailure: InferenceFailure | undefined;
  const process = (run.process ?? runProcess)({ command: run.command, cwd: run.cwd,
    // Empty --tools means defaults in Grok. Allow one known tool, then remove
    // it and the automatically injected lazy-tool discovery pair.
    args: ['--prompt-file', run.promptFile, '--model', run.cliModel, '--tools', 'read_file',
      '--disallowed-tools', 'read_file,search_tool,use_tool', '--deny', '*', '--permission-mode', 'dontAsk', '--no-plan',
      '--no-memory', '--disable-web-search', '--no-subagents', '--max-turns', '1',
      '--reasoning-effort', run.reasoningEffort,
      '--output-format', 'streaming-messages-json', '--verbatim',
      ...(request.system === undefined ? [] : ['--system-prompt-override', request.system]),
      ...(responseSchema === undefined ? [] : ['--json-schema', JSON.stringify(responseSchema)])],
    env: run.env, stdin: '', timeoutMs: run.timeoutMs, signal: request.signal,
    onLine(line) {
      let event: Record<string, unknown>;
      try {
        const raw: unknown = JSON.parse(line);
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || frames.result !== undefined) throw new Error('Invalid frame');
        event = raw as Record<string, unknown>;
      } catch { malformed = true; throw new Error('Malformed Grok protocol'); }
      if (event['type'] === 'system' && event['subtype'] === 'init') {
        frames.init = event;
        try { validateGrokInitialization(frames, mode); }
        catch (error) { nativeFailure = error as InferenceFailure; throw error; }
      }
      if (event['type'] === 'assistant') frames.assistant = event;
      if (event['type'] === 'result' || event['type'] === 'error') frames.result = event;
      if (frames.init === undefined) {
        // A refusal may precede init; classify that typed envelope. Every
        // other frame must fail before further native work is consumed.
        try { decodeGrok(frames, 1, mode); }
        catch (error) { nativeFailure = error as InferenceFailure; throw error; }
      }
    },
  });
  const completed = await process.completion;
  const evidence = grokFailureEvidence(frames, mode);
  if (request.signal?.aborted) throw new InferenceFailure('cancelled', 'Grok inference cancelled', evidence);
  if (nativeFailure) throw nativeFailure;
  if (malformed) throw new InferenceFailure('protocol', 'Malformed Grok protocol', { ...evidence, diagnostic: captureInferenceDiagnostic('transport-framing') });
  if (completed.cancelled || completed.error !== undefined) throw new InferenceFailure('unknown', 'Grok native process did not settle successfully', { ...evidence, diagnostic: captureInferenceDiagnostic('native-process') });
  const result = decodeGrok(frames, completed.exitCode, mode);
  try { validateInferenceResponse(result.text, responseSchema); }
  catch { throw new InferenceFailure('invalid-response', 'Grok response did not match its requested schema', { ...evidence, diagnostic: captureInferenceDiagnostic('response-schema', result.text) }); }
  return result;
}
