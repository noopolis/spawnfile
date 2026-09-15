import { expect, it, vi } from 'vitest';
import type { ProcessOptions, ProcessResult, RunningProcess } from '../../platform/process/index.js';
import { createRoutedInference } from '../routing.js';
import { createClaudeInference } from './provider.js';

const auth = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' });
const init = JSON.stringify({ type: 'system', subtype: 'init', tools: [], mcp_servers: [], model: 'reported-model' });
const terminal = JSON.stringify({ type: 'result', subtype: 'success', result: 'PRIVATE output', model: 'terminal-model',
  usage: { input_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1, output_tokens: 4 } });
const secret = 'PRIVATE auth login quota 429 timeout transport';
const stop = { state: 'acknowledged' as const, scope: 'process-group' as const, quiescence: 'confirmed' as const,
  remoteWork: 'unknown' as const, reason: 'timeout', detail: 'owner receipt' };

type Scenario = { lines?: string[]; authLines?: string[]; authResult?: Partial<ProcessResult>;
  result?: Partial<ProcessResult>; reject?: 'auth' | 'generation'; interrupt?: (options: ProcessOptions) => void };
function native(scenario: Scenario) {
  const calls: ProcessOptions[] = [];
  const execute = (options: ProcessOptions): RunningProcess => {
    calls.push(options);
    const isAuth = options.args.includes('status');
    return { write: async () => undefined, endInput: () => undefined, stop: async reason => ({ ...stop, reason }),
      completion: (async () => {
        if (scenario.reject === (isAuth ? 'auth' : 'generation')) throw new Error(secret);
        try {
          for (const line of isAuth ? scenario.authLines ?? [auth] : scenario.lines ?? [init, terminal]) {
            await options.onLine(line, new AbortController().signal);
          }
          if (!isAuth) scenario.interrupt?.(options);
          return { exitCode: 0, cancelled: false, stderr: secret, ...(isAuth ? scenario.authResult : scenario.result) };
        } catch (error) {
          // Actual process owner stops on an observer exception as well as on cancellation.
          return { exitCode: null, cancelled: true, error: String(error), stderr: secret };
        }
      })(),
    };
  };
  return { provider: createClaudeInference({ process: execute }), calls };
}
function routed(scenario: Scenario) {
  const first = native(scenario), fallback = vi.fn(async () => ({ text: 'fallback', model: 'backup', route: 'backup', usage: null }));
  const route = createRoutedInference({ id: 'review', timeoutMs: 5000, maxAttempts: 2,
    routes: [{ provider: first.provider, model: 'requested' },
      { provider: { ...first.provider, id: 'backup', generate: fallback }, model: 'backup' }] });
  return { ...first, route, fallback };
}

it.each([
  { name: 'failed auth check', scenario: { authResult: { exitCode: 1 } }, kind: 'authentication' },
  { name: 'no saved login', scenario: { authLines: ['{"loggedIn":false}'] }, kind: 'authentication' },
  { name: 'malformed auth response', scenario: { authLines: [secret] }, kind: 'protocol' },
  { name: 'missing auth envelope', scenario: { authLines: [] }, kind: 'protocol' },
  { name: 'interrupted auth process', scenario: { authResult: { cancelled: true, error: secret } }, kind: 'unknown' },
  { name: 'rejected auth process', scenario: { reject: 'auth' }, kind: 'unknown' },
] as const)('routes $name as $kind without guessing from native text or trying another model', async ({ scenario, kind }) => {
  const f = routed(scenario as Scenario);
  const error = await f.route.generate({ model: 'ignored', prompt: 'PRIVATE prompt' }).catch(error => error);
  expect(error).toMatchObject({ kind, attempts: [{ failureKind: kind, providerId: 'claude-subscription', usage: null }] });
  expect(f.calls).toHaveLength(1); expect(f.fallback).not.toHaveBeenCalled();
  expect(JSON.stringify(error)).not.toContain('PRIVATE');
});

it.each([
  { name: 'missing isolation', scenario: { lines: [terminal] }, kind: 'protocol' },
  { name: 'invalid isolation', scenario: { lines: [terminal, '{"type":"system","subtype":"init","tools":["Bash"]}'] }, kind: 'protocol' },
  { name: 'malformed stream', scenario: { lines: [init, terminal, secret] }, kind: 'protocol' },
  { name: 'native process interruption', scenario: { result: { cancelled: true } }, kind: 'unknown' },
  { name: 'arbitrary native error', scenario: { result: { error: secret } }, kind: 'unknown' },
  { name: 'nonzero native exit', scenario: { result: { exitCode: 1 } }, kind: 'protocol' },
] as const)('retains observed usage for $name and stops its authored route as $kind', async ({ scenario, kind }) => {
  const f = routed(scenario as Scenario);
  const error = await f.route.generate({ model: 'ignored', prompt: 'PRIVATE prompt' }).catch(error => error);
  expect(error).toMatchObject({ kind, attempts: [{ failureKind: kind, responseModel: 'terminal-model',
    responseRoute: 'claude-subscription', usage: { inputTokens: 6, cachedInputTokens: 2, cacheWriteInputTokens: 1, outputTokens: 4 } }] });
  expect(error.attempts).toHaveLength(1); expect(f.calls).toHaveLength(2); expect(f.fallback).not.toHaveBeenCalled();
  expect(JSON.stringify(error)).not.toContain('PRIVATE');
});

it('keeps an omitted terminal distinct from a rejected generation process', async () => {
  for (const [scenario, kind] of [[{ lines: [init] }, 'protocol'], [{ reject: 'generation' }, 'unknown']] as const) {
    const f = routed(scenario as Scenario);
    await expect(f.route.generate({ model: 'm', prompt: 'p' })).rejects.toMatchObject({ kind, attempts: [{ failureKind: kind, usage: null }] });
    expect(f.fallback).not.toHaveBeenCalled();
  }
});

it('uses the process owner timeout receipt to retain usage and permit only the existing authored timeout fallback', async () => {
  const f = routed({ result: { cancelled: true, error: secret, stop } });
  const result = await f.route.generate({ model: 'm', prompt: 'p' });
  expect(result.attempts).toMatchObject([{ failureKind: 'timeout', usage: { inputTokens: 6, outputTokens: 4 } },
    { outcome: 'completed', requestedModel: 'backup' }]);
  expect(f.fallback).toHaveBeenCalledOnce();
});

it('attributes caller cancellation independently of the process owner stop flag', async () => {
  const controller = new AbortController();
  const f = routed({ interrupt: () => controller.abort() });
  await expect(f.route.generate({ model: 'm', prompt: 'p', signal: controller.signal })).rejects.toMatchObject({ kind: 'cancelled' });
  expect(f.fallback).not.toHaveBeenCalled();
  const directController = new AbortController();
  const direct = native({ interrupt: () => directController.abort() });
  await expect(direct.provider.generate({ model: 'm', prompt: 'p', signal: directController.signal })).rejects.toMatchObject({
    kind: 'cancelled', responseModel: 'terminal-model', usage: { inputTokens: 6, outputTokens: 4 } });
});

it('retains measured usage on a structured native quota refusal without reclassifying it from prose', async () => {
  const f = native({ lines: [init, JSON.stringify({ ...JSON.parse(terminal), is_error: true,
    terminal_reason: 'api_error', api_error_status: 429, result: secret })], result: { exitCode: 1 } });
  const error = await f.provider.generate({ model: 'm', prompt: 'p' }).catch(error => error);
  expect(error).toMatchObject({ kind: 'quota', usage: { inputTokens: 6, outputTokens: 4 }, responseModel: 'terminal-model' });
  expect(String(error)).not.toContain('PRIVATE');
});


it.each([401, null, 503, '401'] as const)('classifies only strict native API status without guessing from an expired-session message (%j)', async status => {
  const f = routed({ lines: [init, JSON.stringify({ ...JSON.parse(terminal), is_error: true,
    terminal_reason: 'api_error', api_error_status: status, result: 'PRIVATE Failed to authenticate: OAuth session expired' })],
    result: { exitCode: 1 } });
  const kind = status === 401 ? 'authentication' : 'unknown';
  const error = await f.route.generate({ model: 'm', prompt: 'p', responseSchema: { type: 'object' } }).catch(error => error);
  expect(error).toMatchObject({ kind, attempts: [{ failureKind: kind, responseModel: 'terminal-model', usage: { inputTokens: 6 } }] });
  expect(f.fallback).not.toHaveBeenCalled(); expect(JSON.stringify(error)).not.toContain('PRIVATE');
});
