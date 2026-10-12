import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
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
function provider(text: string, expectedSchema: Record<string, unknown> = strict) {
  return createCodexInference({ process: options => ({
    write: async () => undefined, endInput: () => undefined,
    stop: async reason => ({ state: 'acknowledged', scope: 'process-group', quiescence: 'confirmed', remoteWork: 'unknown', reason, detail: 'test' }),
    completion: (async () => {
      if (options.args.includes('status')) return { exitCode: 0, stderr: 'Logged in using ChatGPT', cancelled: false };
      const file = options.args[options.args.indexOf('--output-schema') + 1]!;
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(expectedSchema);
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
  const input = { type: 'object', additionalProperties: false, properties: {
    minimum: { type: 'string', minLength: 1, maxLength: 5, pattern: '^a', format: 'email', enum: ['minimum'] },
    rows: { type: 'array', items: { $ref: '#/definitions/row' } },
    choice: { anyOf: [{ type: 'object', additionalProperties: false, properties: { x: { type: 'number' } } }, { type: 'null' }] },
  }, definitions: { row: { type: ['object', 'null'], additionalProperties: false, properties: { p: { type: 'number', minimum: 0 } } } } };
  const result = codexStrictSchema(input);
  expect(result['properties']).toMatchObject({
    minimum: { anyOf: [{ type: 'string', enum: ['minimum'] }, { type: 'null' }] },
    rows: { anyOf: [{ type: 'array', items: { $ref: '#/definitions/row' } }, { type: 'null' }] },
  });
  expect(result['definitions']).toEqual({ row: { type: ['object', 'null'], properties: { p: { anyOf: [{ type: 'number' }, { type: 'null' }] } }, required: ['p'], additionalProperties: false } });
  expect(codexStrictSchema({ type: 'object', additionalProperties: false })).toEqual({ type: 'object', properties: {}, required: [], additionalProperties: false });
});
it('normalizes nested arrays, escaped local references and union branches without deleting required nulls', () => {
  const nested = { type: 'object', additionalProperties: false, properties: {
    rows: { type: 'array', items: { $ref: '#/definitions/a~1b' } },
    choice: { anyOf: [{ type: 'number' }, { type: 'object', additionalProperties: false, properties: { x: { type: 'string' } } }] },
    requiredNull: { type: 'null' }, free: true,
  }, required: ['requiredNull'], definitions: { 'a/b': { type: 'object', additionalProperties: false, properties: { p: { type: 'number' } } } } };
  expect(JSON.parse(normalizeCodexResponse('{"rows":[{"p":null},{}],"choice":{"x":null},"requiredNull":null,"free":3}', nested)))
    .toEqual({ rows: [{}, {}], choice: {}, requiredNull: null, free: 3 });
  expect(normalizeCodexResponse('{"choice":false}', nested)).toBe('{"choice":false}');
  expect(normalizeCodexResponse('```json\n{}\n```', nested, true)).toBe('```json\n{}\n```');
  expect(codexStrictSchema({ type: 'array', items: [{ type: 'object', additionalProperties: false }], additionalItems: false })['items'])
    .toEqual([{ type: 'object', properties: {}, required: [], additionalProperties: false }]);
  expect(normalizeCodexResponse('[{"x":null},2]', { type: 'array', minItems: 2, additionalItems: false, items: [{ type: 'object', additionalProperties: false, properties: { x: { type: 'string' } } }, true] }))
    .toBe('[{},2]');
});

it.each([
  { type: 'object', required: ['x'] },
  { type: 'object', additionalProperties: false, properties: { y: { type: 'string' } }, required: ['x'] },
  { type: 'object' },
  { type: 'object', properties: { x: { type: 'string' } } },
  { type: 'object', additionalProperties: true },
  { type: 'object', additionalProperties: { type: 'string' } },
  { type: 'object', additionalProperties: false, patternProperties: { '^x': { type: 'string' } } },
  { type: 'array', items: { type: 'object' } },
  { type: 'object', additionalProperties: false, properties: { x: { $ref: '#/definitions/free' } },
    definitions: { free: { type: 'object' } } },
  { anyOf: [{ type: 'null' }, { type: 'object', required: ['x'] }] },
])('rejects unrepresentable strict schemas before any provider process: %j', async responseSchema => {
  const process = vi.fn(() => { throw new Error('must not launch'); });
  const missing = JSON.stringify(responseSchema).includes('required');
  await expect(createCodexInference({ process }).generate({ model: 'chosen', prompt: 'judge', responseSchema }))
    .rejects.toMatchObject({ kind: 'unsupported', message: expect.stringContaining(missing ? 'required name' : 'free-form objects') });
  expect(process).not.toHaveBeenCalled();
});

it('preserves originally nullable optional data and removes only added placeholders end to end', async () => {
  const nullable = { type: 'object', additionalProperties: false, properties: {
    typed: { type: ['string', 'null'] }, choice: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    enumerated: { enum: ['yes', null] }, constant: { const: null }, free: true,
    'a/b~c': { $ref: '#/definitions/nullable' },
    constrained: { type: ['string', 'null'], not: { type: 'null' } },
    missing: { type: 'string' },
    rows: { type: 'array', items: { $ref: '#/definitions/row' } },
  }, definitions: {
    nullable: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    row: { type: 'object', additionalProperties: false, properties: {
      kept: { $ref: '#/definitions/nullable' }, removed: { type: 'number' },
    } },
  } };
  const text = JSON.stringify({ typed: null, choice: null, enumerated: null, constant: null,
    free: null, 'a/b~c': null, constrained: null, missing: null, rows: [{ kept: null, removed: null }] });
  const expected = { typed: null, choice: null, enumerated: null, constant: null,
    free: null, 'a/b~c': null, rows: [{ kept: null }] };
  const result = await provider(text, codexStrictSchema(nullable)).generate({
    model: 'chosen', prompt: 'judge', responseSchema: nullable,
  });
  expect(JSON.parse(result.text)).toEqual(expected);
  expect(normalizeCodexResponse(JSON.stringify(expected), nullable)).toBe(JSON.stringify(expected));
});


it.each(['anyOf', 'oneOf'])('preserves valid nullable data in a later %s branch', keyword => {
  const original = { [keyword]: [
    { type: 'object', additionalProperties: false, properties: { x: { type: 'string' } } },
    { type: 'object', additionalProperties: false, properties: { x: { type: 'null' } } },
  ] };
  expect(normalizeCodexResponse('{"x":null}', original)).toBe('{"x":null}');
});
