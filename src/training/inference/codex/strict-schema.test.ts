import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createCodexInference } from './provider.js';
import { codexStrictSchema, normalizeCodexResponse } from './strict-schema.js';

// Exact council wire shape; provider tests must not import grader internals.
const schema = { type: 'object', additionalProperties: false, required: ['q1'], properties: {
  q1: { type: 'object', additionalProperties: false, required: ['answer'], properties: {
    answer: { type: 'string', enum: ['yes', 'no', 'abstain'] },
    p: { type: 'number', minimum: 0, maximum: 1 }, span: { type: 'string', minLength: 1 },
  } },
} };
const strict = { type: 'object', additionalProperties: false, required: ['q1'], properties: {
  q1: { type: 'object', additionalProperties: false, required: ['answer', 'p', 'span'], properties: {
    answer: { type: 'string', enum: ['yes', 'no', 'abstain'] },
    p: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    span: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  } },
} };
function provider(text: string) {
  return createCodexInference({ process: options => ({
    write: async () => undefined, endInput: () => undefined,
    stop: async reason => ({ state: 'acknowledged', scope: 'process-group', quiescence: 'confirmed', remoteWork: 'unknown', reason, detail: 'test' }),
    completion: (async () => {
      if (options.args.includes('status')) return { exitCode: 0, stderr: 'Logged in using ChatGPT', cancelled: false };
      const file = options.args[options.args.indexOf('--output-schema') + 1]!;
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(strict);
      for (const event of [
        { type: 'thread.started', thread_id: 't', model: 'reported' }, { type: 'turn.started' },
        { type: 'item.completed', item: { id: 'a', type: 'agent_message', text } },
        { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
      ]) await options.onLine(JSON.stringify(event), new AbortController().signal);
      return { exitCode: 0, stderr: '', cancelled: false };
    })(),
  }) });
}
it('writes the strict council schema without changing the original', async () => {
  const original = structuredClone(schema);
  expect(codexStrictSchema(schema)).toEqual(strict);
  const result = await provider('{"q1":{"answer":"yes","p":null,"span":null}}').generate({ model: 'chosen', prompt: 'judge', responseSchema: schema });
  expect(JSON.parse(result.text)).toEqual({ q1: { answer: 'yes' } });
  expect(result).toMatchObject({ model: 'reported', usage: { inputTokens: 10 } });
  expect(schema).toEqual(original);
});
it.each([
  '{"q1":{"answer":"yes","p":1.5,"span":null}}',
  '{"q1":{"answer":"yes","p":-0.1,"span":null}}',
  '{"q1":{"answer":"yes","p":null,"span":""}}',
  '{"q1":{"answer":null,"p":null,"span":null}}',
  '{"q1":{"p":null,"span":null}}',
  '{"q1":{"answer":"yes","p":null,"p":0.5,"span":null}}',
  '{"q1":{"answer":"yes","p":null,"span":null,"extra":null}}',
  '{"q1":{"answer":"yes","p":1e400,"span":null}}',
])('rejects invalid council responses using original constraints: %s', async text => {
  await expect(provider(text).generate({ model: 'chosen', prompt: 'judge', responseSchema: schema }))
    .rejects.toMatchObject({ kind: 'invalid-response', usage: { inputTokens: 10 }, responseModel: 'reported' });
});
it('normalizes opted-in fences and preserves valid non-null optional values', async () => {
  for (const text of ['{"q1":{"answer":"yes","p":0.5,"span":"quote"}}', '{"q1":{"answer":"yes"}}']) {
    expect((await provider(text).generate({ model: 'chosen', prompt: 'judge', responseSchema: schema })).text).toBe(text);
  }
  const text = '```json\n{"q1":{"answer":"yes","p":null,"span":null}}\n```';
  expect(JSON.parse((await provider(text).generate({ model: 'chosen', prompt: 'judge', responseSchema: schema, responseJsonFence: true })).text))
    .toEqual({ q1: { answer: 'yes' } });
  await expect(provider(text).generate({ model: 'chosen', prompt: 'judge', responseSchema: schema })).rejects.toMatchObject({ kind: 'invalid-response' });
});
it('translates nested arrays, references, unions and literal keyword names', () => {
  const input = { type: 'object', properties: {
    minimum: { type: 'string', minLength: 1, maxLength: 5, pattern: '^a', format: 'email', enum: ['minimum'] },
    rows: { type: 'array', items: { $ref: '#/definitions/row' } },
    choice: { anyOf: [{ type: 'object', properties: { x: { type: 'number' } } }, { type: 'null' }] },
  }, definitions: { row: { type: ['object', 'null'], properties: { p: { type: 'number', minimum: 0 } } } } };
  const result = codexStrictSchema(input);
  expect(result['properties']).toMatchObject({
    minimum: { anyOf: [{ type: 'string', enum: ['minimum'] }, { type: 'null' }] },
    rows: { anyOf: [{ type: 'array', items: { $ref: '#/definitions/row' } }, { type: 'null' }] },
  });
  expect(result['definitions']).toEqual({ row: { type: ['object', 'null'], properties: { p: { anyOf: [{ type: 'number' }, { type: 'null' }] } }, required: ['p'], additionalProperties: false } });
  expect(codexStrictSchema({ type: 'object', additionalProperties: true })).toEqual({ type: 'object', properties: {}, required: [], additionalProperties: false });
});
it('normalizes nested arrays, escaped local references and union branches without deleting required nulls', () => {
  const nested = { type: 'object', properties: {
    rows: { type: 'array', items: { $ref: '#/definitions/a~1b' } },
    choice: { anyOf: [{ type: 'number' }, { type: 'object', properties: { x: { type: 'string' } } }] },
    requiredNull: { type: 'null' }, free: true,
  }, required: ['requiredNull'], definitions: { 'a/b': { type: 'object', properties: { p: { type: 'number' } } } } };
  expect(JSON.parse(normalizeCodexResponse('{"rows":[{"p":null},{}],"choice":{"x":null},"requiredNull":null,"free":3}', nested)))
    .toEqual({ rows: [{}, {}], choice: {}, requiredNull: null, free: 3 });
  expect(normalizeCodexResponse('{"choice":false}', nested)).toBe('{"choice":false}');
  expect(normalizeCodexResponse('```json\n{}\n```', nested, true)).toBe('```json\n{}\n```');
  expect(codexStrictSchema({ type: 'array', items: [{ type: 'object' }], additionalItems: false })['items'])
    .toEqual([{ type: 'object', properties: {}, required: [], additionalProperties: false }]);
  expect(normalizeCodexResponse('[{"x":null},2]', { type: 'array', items: [{ type: 'object', properties: { x: { type: 'string' } } }] }))
    .toBe('[{},2]');
});
