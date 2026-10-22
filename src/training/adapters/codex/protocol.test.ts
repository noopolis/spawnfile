import { expect, it } from 'vitest';
import type { Observation } from '../../contracts/execution.js';
import { asObject, codexUsage, decodeCodex, usageDelta } from './protocol.js';

it('captures authentic dispatch/completion identities and source-local ordering', async () => {
  const events: Observation[] = [];
  const decoder = decodeCodex('trial', 'wake', (event) => { events.push(event); });
  for (const event of [
    { type: 'thread.started', thread_id: 'native-thread' },
    { type: 'item.started', item: { id: 'call', type: 'command_execution', command: 'write result' } },
    { type: 'item.completed', item: { id: 'call', type: 'command_execution', command: 'write result', exit_code: 0, aggregated_output: 'ok' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
    { type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 4 } },
  ]) await decoder.decode(JSON.stringify(event));
  expect(decoder).toMatchObject({ text: 'done', threadId: 'native-thread', completed: true });
  expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
  expect(events[1]).toMatchObject({ success: true, callId: 'call', causalParents: [events[0]!.id] });
  expect(decoder.usage?.reasoningTokens).toBeNull();
});

it('subtracts exact native thread baselines on resume and preserves missing/regressed counters', async () => {
  const baseline = codexUsage({ input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 });
  const decoder = decodeCodex('trial', 'wake2', () => undefined, baseline);
  await decoder.decode('{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":60,"output_tokens":13}}');
  expect(decoder.usage).toMatchObject({ inputTokens: 20, cachedInputTokens: 10, outputTokens: 3, reasoningTokens: null });
  expect(decoder.cumulativeUsage?.inputTokens).toBe(120);
  expect(usageDelta(baseline, null).inputTokens).toBeNull();
  expect(usageDelta(baseline, codexUsage({ input_tokens: 500 })).inputTokens).toBeNull();
});

it('retains failed native tools, missing dispatch, and unknown success honestly', async () => {
  const events: Observation[] = [];
  const decoder = decodeCodex('trial', 'wake', (event) => { events.push(event); });
  for (const item of [
    { id: 'mcp', type: 'mcp_tool_call', tool: 'validate', arguments: { body: 'bad' }, result: { valid: false }, status: 'failed' },
    { id: 'patch', type: 'file_change', changes: [], status: 'completed' },
    { id: 'search', type: 'web_search', query: 'news' },
    { id: 'command', type: 'command_execution', command: 'false', exit_code: 1 },
    { id: 'unknown', type: 'future_tool' },
  ]) await decoder.decode(JSON.stringify({ type: 'item.completed', item }));
  expect(events).toHaveLength(4);
  expect(events[0]).toMatchObject({ tool: 'validate', success: false, causalParents: [] });
  expect(events[1]?.success).toBe(true);
  expect(events[2]?.success).toBeUndefined();
  expect(events[3]?.success).toBe(false);
});

it('does not treat a zero-exit error envelope or malformed stream as success', async () => {
  const decoder = decodeCodex('trial', 'wake', () => undefined);
  await decoder.decode('{"type":"error","message":"quota exhausted"}');
  expect(decoder.failed).toBe('quota exhausted');
  await decoder.decode('{"type":"turn.failed","error":{"message":"bad"}}');
  expect(decoder.failed).toContain('bad');
  await decoder.decode('{"type":"turn.failed"}');
  expect(decoder.failed).toContain('turn.failed');
  for (const event of [null, [], {}, { type: 'thread.started' }, { type: 'item.completed', item: { type: 'agent_message' } },
    { type: 'item.started', item: { type: 'command_execution' } }]) {
    await expect(decoder.decode(JSON.stringify(event))).rejects.toThrow();
  }
  await expect(decoder.decode('not JSON')).rejects.toThrow();
  expect(() => asObject(1)).toThrow();
  expect(codexUsage({ input_tokens: -1, cached_input_tokens: 'unknown', output_tokens: Infinity })).toMatchObject({ inputTokens: null, outputTokens: null });
  expect(codexUsage(null).inputTokens).toBeNull();
});
