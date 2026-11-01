import { afterEach, expect, test } from 'vitest';
import { InferenceFailure } from '../../../../training/index.js';
import { bindBootedJudges, createBootedJudgeInference, transcriptToolActivity, type BootedJudgeSpec } from './judge.js';
import type { BootedWake } from './adapter.js';

const row = { input: 120, cache_read: 40, output: 6, notional_usd: 0, complete: true };
const clean = ['{"type":"session_meta","payload":{"id":"s"}}', '{"type":"response_item","payload":{"type":"message","role":"assistant"}}',
  '{"type":"response_item","payload":{"type":"reasoning"}}', '{"type":"event_msg","payload":{"type":"token_count"}}'].join('\n');
const schema = { type: 'object', properties: { score: { type: 'integer' } }, required: ['score'], additionalProperties: false };

const bind = (wake: Partial<BootedWake>, log: { specs: BootedJudgeSpec[]; texts: string[] } = { specs: [], texts: [] }) => {
  bindBootedJudges({ judge: async (spec) => { log.specs.push(spec); return { wake: async (text) => {
    log.texts.push(text);
    return { state: 'completed', acceptanceId: 'a', executionId: 'e', code: null, text: '{"score":9}', usage: [row], transcript: clean, ...wake };
  } }; } });
  return log;
};
const judge = (engine = 'grok') => createBootedJudgeInference({ engine, effort: 'low' });
const failure = async (promise: Promise<unknown>): Promise<InferenceFailure> => {
  try { await promise; } catch (error) { if (error instanceof InferenceFailure) return error; throw error; }
  throw new Error('expected an inference failure');
};

afterEach(() => bindBootedJudges(undefined));

test('wakes the run judge for its engine, model and effort and returns a schema-valid reply with ledger usage', async () => {
  const log = bind({});
  const result = await judge().generate({ prompt: 'Score it.', system: 'Be strict.', model: 'grok-4.6', responseSchema: schema });
  expect(result).toEqual({ text: '{"score":9}', model: 'grok-4.6', modelBasis: 'requested-assumption', route: 'grok-subscription',
    usage: { inputTokens: 120, cachedInputTokens: 40, outputTokens: 6, reasoningTokens: null, notionalUsd: 0, source: 'daimon-turn-usage-ledger' } });
  expect(log.specs).toEqual([{ engine: 'grok', model: 'grok-4.6', effort: 'low' }]);
  expect(log.texts[0]).toMatch(/^Be strict\.\n\nScore it\.\n\nReply with exactly one JSON value .*\n\{"type":"object"/su);
});

test('refuses a judgment whose transcript shows any tool activity', async () => {
  bind({ transcript: `${clean}\n{"type":"response_item","payload":{"type":"function_call","name":"shell"}}` });
  const refused = await failure(judge('codex').generate({ prompt: 'Score it.', model: 'm', responseSchema: schema }));
  expect(refused).toMatchObject({ kind: 'protocol', detail: 'tool-call', message: 'codex-subscription attempt refused: tool-call' });
  expect(refused.usage).toMatchObject({ outputTokens: 6 });
});

test('refuses a judgment without evidence that it was tool-free', async () => {
  bind({ transcript: null });
  expect(await failure(judge().generate({ prompt: 'p', model: 'm' }))).toMatchObject({ kind: 'protocol' });
  bind({ transcript: null, requestToolCalls: [[], null] });
  expect(await failure(judge().generate({ prompt: 'p', model: 'm' }))).toMatchObject({ kind: 'protocol' });
});

test('accepts per-request tool records as proof and refuses any recorded tool call', async () => {
  bind({ transcript: null, requestToolCalls: [[], []] });
  expect((await judge().generate({ prompt: 'p', model: 'm', responseSchema: schema })).text).toBe('{"score":9}');
  bind({ transcript: null, requestToolCalls: [['read_file'], []] });
  expect(await failure(judge().generate({ prompt: 'p', model: 'm' }))).toMatchObject({ kind: 'protocol', detail: 'tool-call' });
});

test('refuses a reply that violates the requested schema, and accepts a json fence only when asked', async () => {
  bind({ text: '{"score":"high"}' });
  expect(await failure(judge().generate({ prompt: 'p', model: 'm', responseSchema: schema }))).toMatchObject({ kind: 'invalid-response' });
  bind({ text: '```json\n{"score":3}\n```' });
  expect(await failure(judge().generate({ prompt: 'p', model: 'm', responseSchema: schema }))).toMatchObject({ kind: 'invalid-response' });
  expect((await judge().generate({ prompt: 'p', model: 'm', responseSchema: schema, responseJsonFence: true })).text).toBe('```json\n{"score":3}\n```');
});

test('maps failed wakes and refuses outside a training run', async () => {
  expect(await failure(judge().generate({ prompt: 'p', model: 'm' }))).toMatchObject({ kind: 'unavailable' });
  bind({ state: 'failed', code: 'engine_failed', text: 'gateway answered 403 auth_stale' });
  expect(await failure(judge().generate({ prompt: 'p', model: 'm' }))).toMatchObject({ kind: 'authentication' });
  bind({ state: 'timeout' });
  expect(await failure(judge().generate({ prompt: 'p', model: 'm' }))).toMatchObject({ kind: 'timeout' });
  await expect(judge().generate({ prompt: 'p', model: 'm', temperature: 0 })).rejects.toMatchObject({ kind: 'unsupported' });
});

test('reads tool activity from record and item kinds, at any engine', () => {
  expect(transcriptToolActivity(clean)).toEqual([]);
  expect(transcriptToolActivity([
    '{"type":"event_msg","payload":{"type":"exec_command_begin"}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"x"},{"type":"tool_use","name":"read_file"}]}}',
    '{"type":"item.completed","item":{"type":"mcp_tool_call"}}',
    'not json',
  ].join('\n'))).toEqual(['exec_command_begin', 'mcp_tool_call', 'tool_use', 'unparseable-record']);
});
