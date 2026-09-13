import { afterEach, expect, it, vi } from 'vitest';
import { claudeEnvironment, decodeClaudeResult, parseEnvelope, savedSubscription } from './protocol.js';

afterEach(() => vi.unstubAllEnvs());

it('requires a nonempty successful result and preserves unavailable usage', () => {
  expect(decodeClaudeResult({ type: 'result', subtype: 'success', result: 'ok' })).toMatchObject({ text: 'ok', usage: null });
  for (const value of [{}, { type: 'result', subtype: 'error' }, { type: 'result', subtype: 'success', is_error: true },
    { type: 'result', subtype: 'success', result: '' }]) expect(() => decodeClaudeResult(value)).toThrow();
  expect(decodeClaudeResult({ type: 'result', subtype: 'success', result: 'ok', model: 'native',
    usage: { input_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 3, output_tokens: 4 },
  })).toMatchObject({ model: 'native', usage: { inputTokens: 28, cachedInputTokens: 20, outputTokens: 4, reasoningTokens: null } });
  expect(decodeClaudeResult({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: -1 } }).usage?.inputTokens).toBeNull();
});

it('requires saved first-party subscription and rejects malformed envelopes', () => {
  expect(savedSubscription({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' })).toBe(true);
  expect(savedSubscription({ loggedIn: false })).toBe(false);
  expect(savedSubscription({ loggedIn: true, authMethod: 'apiKey' })).toBe(false);
  expect(savedSubscription({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'thirdParty' })).toBe(false);
  expect(parseEnvelope('{"type":"result"}')).toEqual({ type: 'result' });
  for (const line of ['null', '[]', '0', 'not JSON']) expect(() => parseEnvelope(line)).toThrow();
});

it('strips API/provider overrides while preserving saved login integration', () => {
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_SIMPLE', 'OPENAI_API_KEY', 'CODEX_API_KEY']) vi.stubEnv(name, 'sensitive');
  vi.stubEnv('CLAUDE_CONFIG_DIR', '/selected/native/login');
  const env = claudeEnvironment();
  expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
  expect(env['CLAUDE_CODE_USE_BEDROCK']).toBeUndefined();
  expect(env['CLAUDECODE']).toBeUndefined();
  expect(env['CLAUDE_CONFIG_DIR']).toBe('/selected/native/login');
});
