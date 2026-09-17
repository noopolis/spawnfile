import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { InferenceProvider } from '../../contracts/execution.js';
import type { runProcess } from '../../platform/process/index.js';
import { InferenceFailure } from '../failure.js';
import { validateInferenceSchema } from '../response-schema.js';
import { runGrokCli } from './cli.js';
import { grokEnvironment } from './protocol.js';

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
        return await runGrokCli({ command: options.command ?? 'grok', cwd, promptFile, env: grokEnvironment(),
          timeoutMs: options.timeoutMs ?? 180_000, cliModel: request.model, reasoningEffort, request, responseSchema,
          mode: { auth: 'subscription' }, process: options.process });
      } finally { await rm(cwd, { recursive: true, force: true }); }
    },
  };
}
