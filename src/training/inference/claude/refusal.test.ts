import { expect, it } from 'vitest';
import type { ProcessOptions, ProcessResult, RunningProcess } from '../../platform/process/index.js';
import { createClaudeInference } from './provider.js';

const quota = { type: 'result', subtype: 'success', is_error: true,
  terminal_reason: 'api_error', api_error_status: 429,
  result: "You've hit your session limit · resets 12:20am (Europe/Berlin)",
  usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } };
const init = JSON.stringify({ type: 'system', subtype: 'init', tools: [], mcp_servers: [] });
const secret = 'PRIVATE PROMPT AUTH OUTPUT';

function run(lines: string[], patch: Partial<ProcessResult> = {}, model = 'claude-fable-5-1') {
  let calls = 0;
  const provider = createClaudeInference({ process: (options: ProcessOptions): RunningProcess => {
    calls += 1;
    const auth = options.args.includes('status');
    return { write: async () => undefined, endInput: () => undefined,
      stop: async reason => ({ state: 'acknowledged', scope: 'process', quiescence: 'confirmed', remoteWork: 'unknown', reason, detail: 'test' }),
      completion: (async () => {
        try {
          for (const line of auth ? ['{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'] : lines) {
            await options.onLine(line, new AbortController().signal);
          }
          return { exitCode: auth ? 0 : 1, cancelled: false, stderr: secret, ...(auth ? {} : patch) };
        } catch (error) { return { exitCode: null, cancelled: true, stderr: secret, error: String(error) }; }
      })(),
    };
  } });
  return { response: provider.generate({ model, prompt: secret, system: secret }), calls: () => calls };
}

it('reports the native exit-1 subscription refusal despite success subtype, without suggesting login or retrying', async () => {
  const attempt = run([init, JSON.stringify(quota)]);
  await expect(attempt.response).rejects.toMatchObject({ name: 'ClaudeProviderRefusalError',
    provider: 'claude-subscription', requestedModel: 'claude-fable-5-1', code: 'subscription-limit',
    httpStatus: 429, resetHint: '12:20am (Europe/Berlin)' });
  const error: unknown = await attempt.response.catch(error => error);
  expect(String(error)).toContain('claude-fable-5-1');
  expect(String(error)).toContain('12:20am (Europe/Berlin)');
  expect(String(error)).not.toMatch(/auth login|PRIVATE/);
  expect(attempt.calls()).toBe(2);
});

it('rejects an early refusal without init acknowledgement and a refusal with exit zero', async () => {
  for (const patch of [{}, { exitCode: 0 }]) {
    await expect(run([JSON.stringify(quota)], patch).response).rejects.toMatchObject({ code: 'subscription-limit' });
  }
});

it.each([secret, null, "You've hit your session limit · resets 99:99am (Europe/Berlin)",
  "You've hit your session limit · resets 12:20am (Not/AZone)",
  "You've hit your session limit · resets 12:20am (Europe/Berlin)\nPRIVATE PROMPT AUTH OUTPUT",
  "You've hit your session limit · resets 12:20am (Europe/Berlin<script>)"])(
  'reports only safe rate-limit metadata for untrusted result text (%j)', async result => {
    const error: unknown = await run([JSON.stringify({ ...quota, result })]).response.catch(error => error);
    expect(error).toMatchObject({ provider: 'claude-subscription', code: 'rate-limit', httpStatus: 429 });
    expect(error).not.toHaveProperty('resetHint');
    expect(String(error)).not.toMatch(/PRIVATE|99:99|Not\/AZone|<script>/);
  });

it('omits an unsafe requested-model value from both diagnostic text and properties', async () => {
  const error: unknown = await run([JSON.stringify(quota)], {}, secret).response.catch(error => error);
  expect(error).toMatchObject({ requestedModel: null, code: 'subscription-limit' });
  expect(`${String(error)}${JSON.stringify(error)}`).not.toContain(secret);
});

it.each([{ is_error: undefined }, { is_error: false }, { api_error_status: '429' },
  { api_error_status: 401 }, { api_error_status: undefined }, { terminal_reason: undefined },
  { terminal_reason: 'other' }, { type: 'assistant' }])('requires strict refusal evidence (%j)', async patch => {
    const error: unknown = await run([init, JSON.stringify({ ...quota, ...patch })]).response.catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toHaveProperty('code');
    expect(String(error)).not.toContain(quota.result);
  });

it('keeps cancellation and protocol failures ahead of an already captured refusal', async () => {
  for (const patch of [{ cancelled: true }, { error: secret }]) {
    const error: unknown = await run([init, JSON.stringify(quota)], patch).response.catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toHaveProperty('code');
    expect(String(error)).not.toContain(secret);
  }
});

it('never exposes malformed protocol bytes and never treats a missing result or nonzero success as completion', async () => {
  for (const lines of [[], ['{"type":"result","result":"PRIVATE PROMPT AUTH OUTPUT" invalid}'],
    [init, JSON.stringify({ type: 'result', subtype: 'success', result: secret })]]) {
    const error: unknown = await run(lines).response.catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toHaveProperty('code');
    expect(String(error)).not.toContain(secret);
  }
});
