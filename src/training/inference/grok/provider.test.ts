import { expect, it } from 'vitest';
import type { ProcessOptions, RunningProcess } from '../../platform/process/index.js';
import { createGrokInference } from './provider.js';
import { decodeGrok, grokEnvironment, type GrokFrames } from './protocol.js';
const frames = (): GrokFrames => ({
  init: { type: 'system', subtype: 'init', apiKeySource: 'oauth', tools: [], model: 'grok-actual' },
  assistant: { type: 'assistant', session_id: 's', message: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'answer' }] } },
  result: { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', session_id: 's', result: 'answer', usage: { input_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1, output_tokens: 4 } },
});
function runner(events: unknown[], patch: Partial<Awaited<RunningProcess['completion']>> = {}) {
  return (options: ProcessOptions): RunningProcess => ({ write: async () => undefined, endInput: () => undefined,
    stop: async reason => ({ state: 'acknowledged', scope: 'process-group', quiescence: 'confirmed', remoteWork: 'unknown', reason, detail: 'test' }),
    completion: (async () => { try {
      for (const event of events) await options.onLine(JSON.stringify(event), new AbortController().signal);
      return { exitCode: 0, stderr: '', cancelled: false, ...patch };
    } catch { return { exitCode: 1, stderr: '', cancelled: true }; } })(),
  });
}
it('runs tool-free OAuth in a disposable workspace and decodes lower-bound usage', async () => {
  let call: ProcessOptions | undefined;
  const result = await createGrokInference({ process: options => { call = options; return runner(Object.values(frames()))(options); } }).generate({ prompt: 'p', system: 's', model: 'requested' });
  expect(result).toMatchObject({ text: 'answer', model: 'grok-actual', usage: { inputTokens: 6, cachedInputTokens: 2, outputTokens: 4 } });
  expect(call?.args).toContain('--no-memory'); expect(call?.args).toContain('--system-prompt-override');
  const { stat } = await import('node:fs/promises'); await expect(stat(call!.cwd)).rejects.toThrow();
});
it('stops native failures and rejects unsupported requests before execution', async () => {
  const provider = createGrokInference({ process: runner([]) });
  for (const patch of [{ prompt: '' }, { model: '' }, { model: '-x' }, { seed: 1 }, { temperature: 0 }]) await expect(provider.generate({ prompt: 'p', model: 'm', ...patch })).rejects.toMatchObject({ kind: 'unsupported' });
  await expect(provider.generate({ prompt: 'p', model: 'm', signal: AbortSignal.abort() })).rejects.toMatchObject({ kind: 'cancelled' });
  for (const patch of [{ cancelled: true }, { error: 'x' }]) await expect(createGrokInference({ process: runner([], patch) }).generate({ prompt: 'p', model: 'm' })).rejects.toMatchObject({ kind: 'unknown' });
  await expect(createGrokInference({ process: runner([...Object.values(frames()), {}]) }).generate({ prompt: 'p', model: 'm' })).rejects.toMatchObject({ kind: 'protocol' });
});
it.each([[429, 'quota'], [503, 'unavailable'], [401, 'authentication'], [403, 'authentication']])('classifies explicit refusal %s', (status, kind) => {
  expect(() => decodeGrok({ result: { status } }, 1)).toThrow(expect.objectContaining({ kind }));
});
it('rejects missing auth, isolation, terminal mismatch and arbitrary tool content', () => {
  expect(() => decodeGrok({}, 0)).toThrow(expect.objectContaining({ kind: 'protocol' }));
  for (const patch of [{ tools: ['read'] }, { tools: undefined }, { mcp_servers: [{}] }]) {
    const value = frames(); Object.assign(value.init!, patch); expect(() => decodeGrok(value, 0)).toThrow('isolation');
  }
  for (const mutate of [
    (v: GrokFrames) => { v.init!['model'] = ''; },
    (v: GrokFrames) => { v.result!['result'] = ''; },
    (v: GrokFrames) => { v.result!['errors'] = ['x']; },
    (v: GrokFrames) => { v.result!['subtype'] = 'error'; },
    (v: GrokFrames) => { v.result!['is_error'] = true; },
    (v: GrokFrames) => { v.result!['stop_reason'] = 'max_tokens'; },
    (v: GrokFrames) => { v.assistant!['session_id'] = 'other'; },
    (v: GrokFrames) => { v.assistant!['message'] = { content: [{ type: 'tool_use' }], stop_reason: 'end_turn' }; },
    (v: GrokFrames) => { delete v.assistant; },
  ]) { const value = frames(); mutate(value); expect(() => decodeGrok(value, 0)).toThrow('matching completed'); }
  expect(() => decodeGrok(frames(), 1)).toThrow('matching completed');
});
it('retains unknown counts and strips ambient API credentials', () => {
  const value = frames(); value.result!['usage'] = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  expect(decodeGrok(value, 0).usage).toBeNull();
  delete value.result!['usage']; expect(decodeGrok(value, 0).usage?.inputTokens).toBeNull();
  process.env['XAI_API_KEY'] = 'secret';
  try { expect(grokEnvironment()['XAI_API_KEY']).toBeUndefined(); } finally { delete process.env['XAI_API_KEY']; }
});
it('classifies the captured Grok balance-exhausted wrapper without parsing model prose', () => {
  const value = frames();
  value.result = { type: 'result', is_error: true, errors: ['Internal error: {"http_status":402,"message":"private"}'] };
  expect(() => decodeGrok(value, 1)).toThrow(expect.objectContaining({ kind: 'quota' }));
  for (const errors of [['Internal error: broken'], ['ordinary text'], [null], ['Internal error: {}'], []]) {
    value.result = { type: 'result', is_error: true, errors };
    expect(() => decodeGrok(value, 1)).toThrow(expect.objectContaining({ kind: 'protocol' }));
  }
});
it('classifies malformed message blocks as protocol failures', () => {
  for (const content of [[null], [{ type: 'text', text: 12 }], [{ type: 'tool_use' }], ['bad']]) {
    const value = frames(); value.assistant!['message'] = { content, stop_reason: 'end_turn' };
    expect(() => decodeGrok(value, 0)).toThrow(expect.objectContaining({ kind: 'protocol' }));
  }
});

it('requires explicit OAuth and rejects non-object native frames', async () => {
  const value = frames(); value.init!['apiKeySource'] = 'api';
  expect(() => decodeGrok(value, 0)).toThrow(expect.objectContaining({ kind: 'authentication' }));
  for (const event of [null, [], 'invalid']) await expect(createGrokInference({ process: runner([event]) })
    .generate({ prompt: 'p', model: 'm' })).rejects.toMatchObject({ kind: 'protocol' });
});
