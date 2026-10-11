import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { InferenceProvider, InferenceRequest } from '../../contracts/execution.js';
import { runProcess, type ProcessResult } from '../../platform/process/index.js';
import { InferenceFailure, type InferenceFailureEvidence } from '../failure.js';
import { validateInferenceResponse, validateInferenceSchema } from '../response-schema.js';
import { classifyCodexFailure, codexEvidence, consumeCodexFrame, type CodexFrames } from './protocol.js';

export interface CodexInferenceOptions {
  command?: string;
  authHome?: string;
  timeoutMs?: number;
  reasoningEffort?: string;
  process?: typeof runProcess;
}

export function codexEnvironment(home: string): NodeJS.ProcessEnv {
  // Allowlist prevents profile, provider, proxy, shell startup and key overrides.
  const env: NodeJS.ProcessEnv = { HOME: home, CODEX_HOME: path.join(home, '.codex') };
  for (const key of ['PATH', 'TMPDIR', 'SystemRoot', 'LANG', 'LC_ALL']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

export function codexArguments(request: InferenceRequest, effort?: string): string[] {
  return ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--json',
    '--ignore-user-config', '--ignore-rules', '--disable', 'memories',
    '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', '-c', 'mcp_servers={}',
    '-c', 'project_doc_max_bytes=0', '-c', 'model_provider="openai"',
    '-c', 'forced_login_method="chatgpt"', '--model', request.model,
    ...(effort === undefined ? [] : ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`]),
    ...(request.system === undefined ? [] : ['-c', `developer_instructions=${JSON.stringify(request.system)}`]), '-'];
}

function interrupted(result: ProcessResult, signal?: AbortSignal, evidence: InferenceFailureEvidence = {}): void {
  if (signal?.aborted) throw new InferenceFailure('cancelled', 'Codex inference cancelled', evidence);
  if (result.stop?.reason === 'timeout') throw new InferenceFailure('timeout', 'Codex native process deadline expired', evidence);
  if (result.error === 'Native protocol ended without a line terminator') throw new InferenceFailure('protocol', 'Truncated Codex event stream', evidence);
  if (result.cancelled || result.error !== undefined) throw new InferenceFailure('transport', 'Codex native process failed', evidence);
}

export function createCodexInference(options: CodexInferenceOptions = {}): InferenceProvider {
  return {
    id: 'codex-subscription',
    capabilities: { tools: 'contained', billing: 'subscription', temperature: false, seed: false },
    async generate(request) {
      validateInferenceSchema(request.responseSchema);
      const schema = request.responseSchema === undefined ? undefined : structuredClone(request.responseSchema);
      if (!request.prompt.trim() || !request.model.trim() || request.model.startsWith('-') ||
        request.temperature !== undefined || request.seed !== undefined ||
        options.reasoningEffort !== undefined && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(options.reasoningEffort)) {
        throw new InferenceFailure('unsupported', 'Invalid Codex inference controls');
      }
      if (request.signal?.aborted) throw new InferenceFailure('cancelled', 'Codex cancelled before launch');
      const root = await mkdtemp(path.join(tmpdir(), 'paideia-codex-inference-'));
      const cwd = path.join(root, 'workspace'), home = path.join(root, 'home');
      const env = codexEnvironment(home);
      const execute = options.process ?? runProcess;
      const command = options.command ?? 'codex';
      const frames: CodexFrames = { started: false, turning: false, completed: false, text: '', usage: null };
      try {
        await mkdir(cwd);
        await mkdir(env['CODEX_HOME']!, { recursive: true });
        const authHome = options.authHome ?? process.env['CODEX_HOME'] ?? path.join(homedir(), '.codex');
        await symlink(path.resolve(authHome, 'auth.json'), path.join(env['CODEX_HOME']!, 'auth.json'));
        let authText = '';
        const auth = await execute({ command, args: ['login', 'status'], cwd, env, stdin: '',
          timeoutMs: 15_000, signal: request.signal, onLine: line => { authText += `${line}\n`; } }).completion;
        interrupted(auth, request.signal);
        const signedIn = auth.exitCode === 0 && /^Logged in using ChatGPT\s*$/u.test(`${authText}${auth.stderr}`.trim());
        authText = '';
        if (!signedIn) throw new InferenceFailure('authentication', 'Codex requires a saved ChatGPT subscription sign-in');
        let failure: InferenceFailure | undefined;
        const result = await execute({ command, args: codexArguments(request, options.reasoningEffort), cwd, env,
          stdin: request.prompt, timeoutMs: options.timeoutMs ?? 180_000, signal: request.signal,
          requireLineTerminator: true,
          onLine: line => {
            try { consumeCodexFrame(frames, line); }
            catch (error) { failure = error as InferenceFailure; throw error; }
          } }).completion;
        if (failure) throw failure;
        interrupted(result, request.signal, codexEvidence(frames));
        if (result.exitCode !== 0) throw new InferenceFailure(classifyCodexFailure(result.stderr), 'Codex generation failed', codexEvidence(frames));
        if (!frames.completed) throw new InferenceFailure('protocol', 'Codex omitted a completed final answer', codexEvidence(frames));
        try { validateInferenceResponse(frames.text, schema); }
        catch { throw new InferenceFailure('invalid-response', 'Codex answer violated the requested schema', codexEvidence(frames)); }
        return { text: frames.text, model: frames.model ?? request.model,
          modelBasis: frames.model === undefined ? 'requested-assumption' : 'provider-reported',
          usage: frames.usage, route: 'codex-subscription' };
      } catch (error) {
        if (error instanceof InferenceFailure) throw error;
        throw new InferenceFailure('transport', 'Codex inference could not complete', codexEvidence(frames));
      } finally { await rm(root, { recursive: true, force: true }); }
    },
  };
}
