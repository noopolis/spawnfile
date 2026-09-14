import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProcess } from '../../platform/process/index.js';
import type { InferenceProvider, InferenceRequest } from '../../contracts/execution.js';
import { claudeEnvironment, decodeClaudeResult, claudeResultUsage, parseEnvelope, savedSubscription } from './protocol.js';
import { claudeRefusal } from './refusal.js';
import { InferenceFailure } from '../failure.js';
import { validateInferenceSchema, validateInferenceResponse } from '../response-schema.js';

export interface ClaudeInferenceOptions {
  command?: string;
  timeoutMs?: number;
  process?: typeof runProcess;
}

export function createClaudeInference(options: ClaudeInferenceOptions = {}): InferenceProvider {
  const execute = options.process ?? runProcess;
  return {
    id: 'claude-subscription',
    capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
    async generate(request) {
      validateInferenceSchema(request.responseSchema);
      const responseSchema = request.responseSchema === undefined ? undefined : structuredClone(request.responseSchema);
      validateRequest(request);
      const cwd = await mkdtemp(path.join(tmpdir(), 'paideia-inference-'));
      const env = claudeEnvironment();
      try {
        let authText = '';
        const auth = await execute({ command: options.command ?? 'claude',
          args: ['--safe-mode', '--restricted', 'auth', 'status', '--json'], cwd, env,
          stdin: '', timeoutMs: 15_000, signal: request.signal,
          onLine: (line) => { authText += line; },
        }).completion;
        let authenticated = false;
        try { authenticated = savedSubscription(parseEnvelope(authText)); } catch { /* Discard raw account details. */ }
        authText = '';
        if (auth.exitCode !== 0 || auth.cancelled || auth.error !== undefined || !authenticated) {
          throw new Error('Saved Claude subscription is unavailable; run claude auth login');
        }
        let result: Record<string, unknown> | undefined;
        let resultLine = '';
        let reportedModel: string | undefined;
        let isolationAcknowledged = false;
        const process = execute({ command: options.command ?? 'claude',
          args: claudeArguments({ ...request, responseSchema }), cwd, env, stdin: request.prompt,
          timeoutMs: options.timeoutMs ?? 180_000, signal: request.signal,
          onLine: (line) => {
            const event = parseEnvelope(line);
            if (event['type'] === 'system' && event['subtype'] === 'init') {
              if (!Array.isArray(event['tools']) || event['tools'].length !== 0) throw new Error('Claude tool-free isolation was not acknowledged');
              isolationAcknowledged = true;
              if (typeof event['model'] === 'string') reportedModel = event['model'];
            }
            if (event['type'] === 'result') { result = event; resultLine = line; }
          },
        });
        const completed = await process.completion;
        if (completed.cancelled) throw new Error('Claude inference was cancelled or stopped after a native failure');
        if (completed.error !== undefined) throw new Error('Claude inference failed (native process or protocol error)');
        const refusal = claudeRefusal(result, request.model);
        if (refusal !== undefined) throw refusal;
        if (completed.exitCode !== 0) throw new InferenceFailure(responseSchema === undefined ? 'protocol' : 'unsupported', `Claude inference failed (exit ${completed.exitCode})`,
          { usage: result === undefined ? null : claudeResultUsage(result), responseModel: reportedModel, responseRoute: 'claude-subscription' });
        if (result === undefined) throw new Error('Claude omitted its terminal result envelope');
        if (!isolationAcknowledged) throw new Error('Claude omitted tool-free isolation acknowledgement');
        let decoded;
        try {
          if (responseSchema !== undefined) validateInferenceResponse(resultLine, { type: 'object' });
          decoded = decodeClaudeResult(result, responseSchema !== undefined);
          validateInferenceResponse(decoded.text, responseSchema);
        } catch {
          throw new InferenceFailure('protocol', 'Claude response violated the requested output contract', { usage: claudeResultUsage(result),
            responseModel: typeof result['model'] === 'string' && result['model'].trim() ? result['model'] : reportedModel, responseRoute: 'claude-subscription' });
        }
        const actualModel = [decoded.model, reportedModel].find(model => model !== undefined && model.trim().length > 0);
        return { text: decoded.text, usage: decoded.usage,
          model: actualModel ?? request.model,
          modelBasis: actualModel === undefined ? 'requested-assumption' : 'provider-reported', route: 'claude-subscription' };
      } finally { await rm(cwd, { recursive: true, force: true }); }
    },
  };
}

export function claudeArguments(request: InferenceRequest): string[] {
  return ['--safe-mode', '--restricted', '--print', '--model', request.model,
    '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--max-turns', '1',
    ...(request.responseSchema === undefined ? [] : ['--json-schema', JSON.stringify(request.responseSchema)]),
    ...(request.system === undefined ? [] : ['--system-prompt', request.system])];
}

function validateRequest(request: InferenceRequest): void {
  if (request.temperature !== undefined || request.seed !== undefined) throw new Error('Subscription route does not support temperature or seed');
  if (request.prompt.trim().length === 0) throw new Error('Inference prompt must not be empty');
  if (request.model.trim().length === 0 || request.model.startsWith('-')) throw new Error('An explicit native model is required');
  if (request.signal?.aborted === true) throw new Error('Inference was cancelled before launch');
}
