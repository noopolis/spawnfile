import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProcess, type ProcessResult } from '../../platform/process/index.js';
import type { InferenceProvider, InferenceRequest } from '../../contracts/execution.js';
import { claudeEnvironment, decodeClaudeResult, claudeFailureEvidence, validateClaudeInitialization, parseEnvelope, savedSubscription } from './protocol.js';
import { claudeRefusal } from './refusal.js';
import { captureInferenceDiagnostic } from '../diagnostic.js';
import { InferenceFailure, type InferenceFailureEvidence } from '../failure.js';
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
      let result: Record<string, unknown> | undefined;
      let reportedModel: string | undefined;
      const evidence = () => claudeFailureEvidence(result, reportedModel);
      try {
        let authText = '';
        const auth = await execute({ command: options.command ?? 'claude',
          args: ['--safe-mode', '--restricted', 'auth', 'status', '--json'], cwd, env,
          stdin: '', timeoutMs: 15_000, signal: request.signal,
          onLine: (line) => { authText += line; },
        }).completion;
        rejectInterruptedProcess(auth, request.signal, undefined, evidence());
        if (auth.exitCode !== 0) throw new InferenceFailure('authentication', 'Saved Claude subscription could not be verified; run claude auth login');
        let authenticated: boolean;
        try { authenticated = savedSubscription(parseEnvelope(authText)); }
        catch { throw new InferenceFailure('protocol', 'Claude authentication status was malformed'); }
        finally { authText = ''; }
        if (!authenticated) throw new InferenceFailure('authentication', 'Saved Claude subscription is unavailable; run claude auth login');
        let resultLine = '';
        let protocolIssue: string | undefined;
        let isolationAcknowledged = false;
        const process = execute({ command: options.command ?? 'claude',
          args: claudeArguments({ ...request, responseSchema }), cwd, env, stdin: request.prompt,
          timeoutMs: options.timeoutMs ?? 180_000, signal: request.signal,
          onLine: (line) => {
            let event: Record<string, unknown>;
            try { event = parseEnvelope(line); }
            catch { protocolIssue = 'Malformed Claude streaming protocol'; throw new Error(protocolIssue); }
            if (event['type'] === 'system' && event['subtype'] === 'init') {
              try { validateClaudeInitialization(event, responseSchema !== undefined); }
              catch { protocolIssue = 'Claude tool-free isolation was not acknowledged'; throw new Error(protocolIssue); }
              isolationAcknowledged = true;
              if (typeof event['model'] === 'string') reportedModel = event['model'];
            }
            if (event['type'] === 'result') { result = event; resultLine = line; }
          },
        });
        const completed = await process.completion;
        rejectInterruptedProcess(completed, request.signal, protocolIssue, evidence());
        const refusal = claudeRefusal(result, request.model, reportedModel);
        if (refusal !== undefined) throw refusal;
        if (completed.exitCode !== 0) throw new InferenceFailure(responseSchema === undefined ? 'protocol' : 'unsupported', `Claude inference failed (exit ${completed.exitCode})`,
          evidence());
        if (result === undefined) throw new InferenceFailure('protocol', 'Claude omitted its terminal result envelope', evidence());
        if (!isolationAcknowledged) throw new InferenceFailure('protocol', 'Claude omitted tool-free isolation acknowledgement', evidence());
        let decoded;
        try {
          if (responseSchema !== undefined) validateInferenceResponse(resultLine, { type: 'object' });
          decoded = decodeClaudeResult(result, responseSchema !== undefined &&
            !(request.responseJsonFence && result['structured_output'] === undefined));

        } catch {
          throw new InferenceFailure('protocol', 'Claude response violated the requested output contract', { ...evidence(), diagnostic: captureInferenceDiagnostic('response-envelope') });
        }
        try { validateInferenceResponse(decoded.text, responseSchema, request.responseJsonFence); }
        catch { throw new InferenceFailure('invalid-response', 'Claude response violated the requested schema', {
          ...evidence(), diagnostic: captureInferenceDiagnostic('response-schema', decoded.text),
        }); }
        const actualModel = [decoded.model, reportedModel].find(model => model !== undefined && model.trim().length > 0);
        return { text: decoded.text, usage: decoded.usage,
          model: actualModel ?? request.model,
          modelBasis: actualModel === undefined ? 'requested-assumption' : 'provider-reported', route: 'claude-subscription' };
      } catch (error) {
        if (error instanceof InferenceFailure) throw error;
        throw new InferenceFailure(request.signal?.aborted ? 'cancelled' : 'unknown', 'Claude native inference did not settle successfully', evidence());
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
  if (request.temperature !== undefined || request.seed !== undefined) throw new InferenceFailure('unsupported', 'Subscription route does not support temperature or seed');
  if (request.prompt.trim().length === 0) throw new InferenceFailure('unsupported', 'Inference prompt must not be empty');
  if (request.model.trim().length === 0 || request.model.startsWith('-')) throw new InferenceFailure('unsupported', 'An explicit native model is required');
  if (request.signal?.aborted === true) throw new InferenceFailure('cancelled', 'Inference was cancelled before launch');
}

/** The process owner may stop on callback failure; cancelled alone is not caller cancellation. */
function rejectInterruptedProcess(result: ProcessResult, signal: AbortSignal | undefined,
  protocolIssue: string | undefined, evidence: InferenceFailureEvidence): void {
  if (signal?.aborted) throw new InferenceFailure('cancelled', 'Claude inference was cancelled', evidence);
  if (protocolIssue !== undefined) throw new InferenceFailure('protocol', protocolIssue, evidence);
  if (result.stop?.reason === 'timeout') throw new InferenceFailure('timeout', 'Claude native process deadline expired', evidence);
  if (result.cancelled || result.error !== undefined) throw new InferenceFailure('unknown', 'Claude native process did not settle successfully', evidence);
}
