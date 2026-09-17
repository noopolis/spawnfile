import { expect, it } from 'vitest';
import { decodeGrok, grokFailureEvidence, validateGrokInitialization, type GrokAuthMode, type GrokFrames } from './protocol.js';

const grant: GrokAuthMode = { auth: 'broker-grant', clientModelId: 'daimon-inference-grok', grantModel: 'grok-4.6' };
/** Frames captured from Grok 1.0.34 running the Paideia judge argv through a real Daimon broker grant (P2c live, stub upstream). */
const captured = (): GrokFrames => ({
  init: { type: 'system', subtype: 'init', model: 'daimon-inference-grok', tools: [], mcp_servers: [], apiKeySource: 'user' },
  assistant: { type: 'assistant', session_id: 's', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"score":1}' }] } },
  result: { type: 'result', subtype: 'success', is_error: false, result: '{"score":1}', stop_reason: 'end_turn', session_id: 's',
    usage: { input_tokens: 40000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 0 } } },
});
const staleError = 'Internal error: "Unauthorized (401) from http://127.0.0.1:43123/v1/chat/completions: auth_stale\\n\\n  Model:     grok-4.5\\n  Auth:      ApiKey\\n  Version:   1.0.34\\n  Available: grok-4.6, grok-4.5, disabled, grok-4.5"';
const stale = (): GrokFrames => ({ init: captured().init,
  result: { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [staleError], stop_reason: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });

it('decodes a captured grant completion as the broker-enforced catalog model with a broker-grant usage label', () => {
  expect(decodeGrok(captured(), 0, grant)).toEqual({ text: '{"score":1}', model: 'grok-4.6', modelBasis: 'provider-reported', route: 'grok-broker-grant',
    usage: { inputTokens: 40000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 50, reasoningTokens: null, source: 'grok-broker-grant.result.usage.lower-bound' } });
});

it('accepts exactly apiKeySource user for a grant and exactly oauth for subscription', () => {
  expect(() => validateGrokInitialization(captured(), grant)).not.toThrow();
  const oauth = captured(); oauth.init!['apiKeySource'] = 'oauth';
  expect(() => validateGrokInitialization(oauth, grant)).toThrow(expect.objectContaining({ kind: 'authentication', message: 'Grok did not acknowledge the broker inference grant' }));
  expect(() => decodeGrok(oauth, 0, grant)).toThrow(expect.objectContaining({ kind: 'authentication' }));
  const subscription = captured(); subscription.init!['model'] = 'grok-4.6';
  expect(() => validateGrokInitialization(subscription)).toThrow(expect.objectContaining({ kind: 'authentication', message: 'Grok did not acknowledge subscription OAuth' }));
  subscription.init!['apiKeySource'] = 'oauth';
  expect(() => validateGrokInitialization(subscription)).not.toThrow();
  for (const source of [undefined, 'api', 'USER', 'none']) {
    const value = captured(); value.init!['apiKeySource'] = source;
    expect(() => validateGrokInitialization(value, grant)).toThrow(expect.objectContaining({ kind: 'authentication' }));
  }
});

it('requires the pinned client model id so a grant run cannot silently use a catalog or desktop model', () => {
  for (const model of ['grok-4.6', 'grok-build', '', undefined]) {
    const value = captured(); value.init!['model'] = model;
    expect(() => decodeGrok(value, 0, grant)).toThrow(expect.objectContaining({ kind: 'authentication', responseModel: null, responseRoute: 'grok-broker-grant' }));
  }
});

it('classifies the captured plain-string 401 auth_stale as a distinct fail-fast failure only for grants', () => {
  expect(() => decodeGrok(stale(), 1, grant)).toThrow(expect.objectContaining({ kind: 'auth-stale', responseRoute: 'grok-broker-grant', usage: null }));
  expect(() => decodeGrok(stale(), 1)).toThrow(expect.objectContaining({ kind: 'authentication' }));
  const unauthorized = stale(); unauthorized.result!['errors'] = ['Internal error: "Unauthorized (401) from http://127.0.0.1:43123/v1/chat/completions: invalid grant"'];
  expect(() => decodeGrok(unauthorized, 1, grant)).toThrow(expect.objectContaining({ kind: 'authentication' }));
  for (const text of ['Internal error: "Rate limited: auth_stale"',
    'Internal error: "prefix Unauthorized (401) from http://127.0.0.1:43123/v1/chat/completions: auth_stale"', 'Internal error: null', 'auth_stale']) {
    const value = stale(); value.result!['errors'] = [text];
    expect(() => decodeGrok(value, 1, grant)).toThrow(expect.objectContaining({ kind: 'protocol' }));
  }
  const remote = stale(); remote.result!['errors'] = ['Internal error: "Unauthorized (401) from https://api.x.ai/v1/chat/completions: auth_stale"'];
  expect(() => decodeGrok(remote, 1, grant)).toThrow(expect.objectContaining({ kind: 'authentication' }));
  const unanchored = stale(); unanchored.result!['errors'] = ['Internal error: "Unauthorized (401) from http://127.0.0.1:43123/v1/chat/completions: auth_stale_not"'];
  expect(() => decodeGrok(unanchored, 1, grant)).toThrow(expect.objectContaining({ kind: 'authentication' }));
});

it('keeps the gate-refusal JSON wrapper classification in grant mode', () => {
  const refused = stale(); refused.result!['errors'] = ['Internal error: {\n  "message": "API error (status 503 Service Unavailable): broker unavailable",\n  "http_status": 503\n}'];
  expect(() => decodeGrok(refused, 1, grant)).toThrow(expect.objectContaining({ kind: 'unavailable' }));
  expect(grokFailureEvidence({}, grant)).toEqual({ usage: null, responseModel: null, responseRoute: 'grok-broker-grant' });
});
