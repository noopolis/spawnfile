import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { InferenceProvider } from '../../contracts/execution.js';
import { runProcess } from '../../platform/process/index.js';
import { InferenceFailure } from '../failure.js';
import { decodeGrok, grokEnvironment, grokFailureEvidence, validateGrokInitialization, type GrokFrames } from './protocol.js';

export interface GrokInferenceOptions { command?: string; timeoutMs?: number; process?: typeof runProcess }

export function createGrokInference(options: GrokInferenceOptions = {}): InferenceProvider {
  return {
    id: 'grok-subscription',
    capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
    async generate(request) {
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
            '--disallowed-tools', 'read_file,search_tool,use_tool', '--deny', '*', '--permission-mode', 'plan',
            '--no-memory', '--disable-web-search', '--no-subagents', '--max-turns', '1',
            '--output-format', 'streaming-messages-json', '--verbatim',
            ...(request.system === undefined ? [] : ['--system-prompt-override', request.system])],
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
        if (malformed) throw new InferenceFailure('protocol', 'Malformed Grok protocol', evidence);
        if (completed.cancelled || completed.error !== undefined) throw new InferenceFailure('unknown', 'Grok native process did not settle successfully', evidence);
        return decodeGrok(frames, completed.exitCode);
      } finally { await rm(cwd, { recursive: true, force: true }); }
    },
  };
}
