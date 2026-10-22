import { expect, it } from 'vitest';
import { createGrokInference } from './provider.js';
import type { ProcessOptions } from '../../platform/process/index.js';
import { InferenceFailure } from '../failure.js';

const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
const frames = () => [
  { type: 'system', subtype: 'init', apiKeySource: 'oauth', tools: [], mcp_servers: [], model: 'grok-4.6' },
  { type: 'assistant', session_id: 's', message: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'HIDDEN REASONING' }, { type: 'text', text: '{"wrong":"PRIVATE ANSWER"}' }] } },
  { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', session_id: 's', result: '{"wrong":"PRIVATE ANSWER"}',
    usage: { input_tokens: 15847, output_tokens: 695, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
] as Record<string, unknown>[];
function create(events = frames()) {
  return createGrokInference({ process: (options: ProcessOptions) => ({ write: async () => undefined, endInput: () => undefined,
    stop: async reason => ({ state: 'acknowledged', scope: 'process-group', quiescence: 'confirmed', remoteWork: 'unknown', reason, detail: 'fixture' }),
    completion: (async () => { try {
      for (const event of events) await options.onLine(JSON.stringify(event), new AbortController().signal);
      return { exitCode: 0, cancelled: false, stderr: '' };
    } catch { return { exitCode: 1, cancelled: true, stderr: '' }; } })(),
  }) });
}

it('distinguishes attested schema rejection from protocol while preserving exact completed text and usage', async () => {
  const error = await create().generate({ prompt: 'p', model: 'grok', responseSchema: schema }).catch(error => error as InferenceFailure);
  if (!(error instanceof InferenceFailure)) throw Error('Expected a typed rejection');
  expect(error).toMatchObject({ kind: 'invalid-response', usage: { inputTokens: 15847, outputTokens: 695 } });
  expect(error.diagnostic).toMatchObject({ code: 'response-schema', response: { text: '{"wrong":"PRIVATE ANSWER"}', omitted: false } });
  expect(JSON.stringify(error.diagnostic)).not.toContain('HIDDEN REASONING');
  expect(JSON.stringify(error)).not.toContain('PRIVATE ANSWER');
});

it.each(['auth', 'tools', 'mcp', 'session', 'stop', 'text', 'blocks', 'unfinished'] as const)('keeps forbidden %s envelopes terminal without retaining response text', async change => {
  const events = frames(), message = events[1]!['message'] as Record<string, unknown>;
  if (change === 'auth') events[0]!['apiKeySource'] = 'api-key';
  if (change === 'tools') events[0]!['tools'] = ['read'];
  if (change === 'mcp') events[0]!['mcp_servers'] = [{}];
  if (change === 'session') events[1]!['session_id'] = 'other';
  if (change === 'stop') message['stop_reason'] = 'other';
  if (change === 'text') events[2]!['result'] = 'other';
  if (change === 'blocks') message['content'] = [{ type: 'tool_use', text: 'PRIVATE TOOL' }];
  if (change === 'unfinished') events[2]!['stop_reason'] = 'max_tokens';
  const error = await create(events).generate({ prompt: 'p', model: 'grok', responseSchema: schema }).catch(error => error as InferenceFailure);
  if (!(error instanceof InferenceFailure)) throw Error('Expected a typed rejection');
  expect(error.kind).toBe(change === 'auth' ? 'authentication' : 'protocol');
  expect(error.diagnostic).toBeDefined(); expect(error.diagnostic).not.toHaveProperty('response');
});
