import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProcess } from '../../platform/process/index.js';
import type { InferenceProvider, InferenceRequest } from '../../contracts/execution.js';
import { claudeEnvironment, decodeClaudeResult, parseEnvelope, savedSubscription } from './protocol.js';

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
        let reportedModel: string | undefined;
        let isolationAcknowledged = false;
        const process = execute({ command: options.command ?? 'claude',
          args: claudeArguments(request), cwd, env, stdin: request.prompt,
          timeoutMs: options.timeoutMs ?? 180_000, signal: request.signal,
          onLine: (line) => {
            const event = parseEnvelope(line);
            if (event['type'] === 'system' && event['subtype'] === 'init') {
              if (!Array.isArray(event['tools']) || event['tools'].length !== 0) throw new Error('Claude tool-free isolation was not acknowledged');
              isolationAcknowledged = true;
              if (typeof event['model'] === 'string') reportedModel = event['model'];
            }
            if (event['type'] === 'result') result = event;
          },
        });
        const completed = await process.completion;
        if (completed.error !== undefined || completed.cancelled || completed.exitCode !== 0) {
          throw new Error(completed.error ?? `Claude inference failed (exit ${completed.exitCode})`);
        }
        if (result === undefined) throw new Error('Claude omitted its terminal result envelope');
        if (!isolationAcknowledged) throw new Error('Claude omitted tool-free isolation acknowledgement');
        const decoded = decodeClaudeResult(result);
        return { text: decoded.text, usage: decoded.usage,
          model: decoded.model ?? reportedModel ?? request.model, route: 'claude-subscription' };
      } finally { await rm(cwd, { recursive: true, force: true }); }
    },
  };
}

export function claudeArguments(request: InferenceRequest): string[] {
  return ['--safe-mode', '--restricted', '--print', '--model', request.model,
    '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--max-turns', '1',
    ...(request.system === undefined ? [] : ['--system-prompt', request.system])];
}

function validateRequest(request: InferenceRequest): void {
  if (request.temperature !== undefined || request.seed !== undefined) throw new Error('Subscription route does not support temperature or seed');
  if (request.prompt.trim().length === 0) throw new Error('Inference prompt must not be empty');
  if (request.model.trim().length === 0 || request.model.startsWith('-')) throw new Error('An explicit native model is required');
  if (request.signal?.aborted === true) throw new Error('Inference was cancelled before launch');
}
