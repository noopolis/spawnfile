import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { InferenceProvider } from '../../contracts/execution.js';
import { runProcess } from '../../platform/process/index.js';
import { captureInferenceDiagnostic } from '../diagnostic.js';
import { InferenceFailure } from '../failure.js';
import { validateInferenceResponse, validateInferenceSchema } from '../response-schema.js';
import { decodeGrok, grokEnvironment, grokFailureEvidence, validateGrokInitialization, type GrokFrames } from './protocol.js';

export interface GrokInferenceOptions {
  command?: string;
  timeoutMs?: number;
  process?: typeof runProcess;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
}

export function createGrokInference(options: GrokInferenceOptions = {}): InferenceProvider {
  return {
    id: 'grok-subscription',
    capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
    async generate(request) {
      validateInferenceSchema(request.responseSchema);
      const responseSchema = request.responseSchema === undefined ? undefined : structuredClone(request.responseSchema);
      const reasoningEffort = options.reasoningEffort === undefined ? 'medium' : options.reasoningEffort;
      if (!['low', 'medium', 'high', 'xhigh'].includes(reasoningEffort)) {
        throw new InferenceFailure('unsupported', 'Invalid Grok reasoning effort');
      }
      if (!request.prompt.trim() || !request.model.trim() || request.model.startsWith('-') ||
        request.temperature !== undefined || request.seed !== undefined) throw new InferenceFailure('unsupported', 'Invalid Grok inference controls');
      if (request.signal?.aborted) throw new InferenceFailure('cancelled', 'Grok cancelled before launch');
      const cwd = await mkdtemp(path.join(tmpdir(), 'paideia-grok-'));
      try {
        const promptFile = path.join(cwd, 'prompt.txt');
        await writeFile(promptFile, request.prompt, { mode: 0o600 });
        const frames: GrokFrames = {};
        let malformed = false;
        let nativeFailure: InferenceFailure | undefined;
        const process = (options.process ?? runProcess)({ command: options.command ?? 'grok', cwd,
          // Empty --tools means defaults in Grok. Allow one known tool, then remove
          // it and the automatically injected lazy-tool discovery pair.
          args: ['--prompt-file', promptFile, '--model', request.model, '--tools', 'read_file',
            '--disallowed-tools', 'read_file,search_tool,use_tool', '--deny', '*', '--permission-mode', 'dontAsk', '--no-plan',
            '--no-memory', '--disable-web-search', '--no-subagents', '--max-turns', '1',
            '--reasoning-effort', reasoningEffort,
            '--output-format', 'streaming-messages-json', '--verbatim',
            ...(request.system === undefined ? [] : ['--system-prompt-override', request.system]),
            ...(responseSchema === undefined ? [] : ['--json-schema', JSON.stringify(responseSchema)])],
          env: grokEnvironment(), stdin: '', timeoutMs: options.timeoutMs ?? 180_000, signal: request.signal,
          onLine(line) {
            let event: Record<string, unknown>;
            try {
              const raw: unknown = JSON.parse(line);
              if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || frames.result !== undefined) throw new Error('Invalid frame');
              event = raw as Record<string, unknown>;
            } catch { malformed = true; throw new Error('Malformed Grok protocol'); }
            if (event['type'] === 'system' && event['subtype'] === 'init') {
              frames.init = event;
              try { validateGrokInitialization(frames); }
              catch (error) { nativeFailure = error as InferenceFailure; throw error; }
            }
            if (event['type'] === 'assistant') frames.assistant = event;
            if (event['type'] === 'result' || event['type'] === 'error') frames.result = event;
            if (frames.init === undefined) {
              // A refusal may precede init; classify that typed envelope. Every
              // other frame must fail before further native work is consumed.
              try { decodeGrok(frames, 1); }
              catch (error) { nativeFailure = error as InferenceFailure; throw error; }
            }
          },
        });
        const completed = await process.completion;
        const evidence = grokFailureEvidence(frames);
        if (request.signal?.aborted) throw new InferenceFailure('cancelled', 'Grok inference cancelled', evidence);
        if (nativeFailure) throw nativeFailure;
        if (malformed) throw new InferenceFailure('protocol', 'Malformed Grok protocol', { ...evidence, diagnostic: captureInferenceDiagnostic('transport-framing') });
        if (completed.cancelled || completed.error !== undefined) throw new InferenceFailure('unknown', 'Grok native process did not settle successfully', { ...evidence, diagnostic: captureInferenceDiagnostic('native-process') });
        const result = decodeGrok(frames, completed.exitCode);
        try { validateInferenceResponse(result.text, responseSchema); }
        catch { throw new InferenceFailure('invalid-response', 'Grok response did not match its requested schema', { ...evidence, diagnostic: captureInferenceDiagnostic('response-schema', result.text) }); }
        return result;
      } finally { await rm(cwd, { recursive: true, force: true }); }
    },
  };
}
