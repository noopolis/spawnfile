import { Ajv } from 'ajv';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createCodexInference } from './provider.js';
import { validateInferenceResponse } from '../response-schema.js';
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
  expect(new Ajv().compile(strict)({ q1: { answer: 'yes', p: null, span: null } })).toBe(true);
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

it('normalizes nested arrays and escaped property names while retaining nullable data', async () => {
  const nullable = { type: 'object', additionalProperties: false, required: ['requiredNull'], properties: {
    typed: { type: ['string', 'null'], description: 'Nullable answer' },
    enumerated: { enum: ['yes', null] }, constant: { const: null },
    'a/b~c': { type: 'string' }, requiredNull: { type: 'null' },
    rows: { type: 'array', items: { type: ['object', 'null'], additionalProperties: false,
      properties: { kept: { type: ['number', 'null'] }, removed: { type: 'number' } } } },
  } };
  const text = JSON.stringify({ typed: null, enumerated: null, constant: null, 'a/b~c': null,
    requiredNull: null, rows: [{ kept: null, removed: null }, null] });
  const expected = { typed: null, enumerated: null, constant: null, requiredNull: null, rows: [{ kept: null }, null] };
  expect(new Ajv().compile(codexStrictSchema(nullable))(JSON.parse(text))).toBe(true);
  const result = await provider(text, codexStrictSchema(nullable)).generate({
    model: 'chosen', prompt: 'judge', responseSchema: nullable,
  });
  expect(JSON.parse(result.text)).toEqual(expected);
  expect(normalizeCodexResponse(JSON.stringify(expected), nullable)).toBe(JSON.stringify(expected));
  expect(normalizeCodexResponse('```json\n{}\n```', nullable, true)).toBe('```json\n{}\n```');
});

it.each([
  ['a%20b', 'a b'], ['a%2520b', 'a%20b'], ['a%7E1b', 'a/b'], ['a%', 'a#é/~'],
].flatMap(([nullableName, placeholderName]) => [false, true].map(nested => ({
  nullableName: nullableName!, placeholderName: placeholderName!, nested,
}))))('preserves nullable $nullableName beside $placeholderName (nested: $nested)', async ({ nullableName, placeholderName, nested }) => {
  const row = { type: 'object', additionalProperties: false, properties: {
    [nullableName]: { type: ['string', 'null'] }, [placeholderName]: { type: 'string' },
  } };
  const original = nested ? { type: 'object', additionalProperties: false, properties: {
    'rows%20/~#é': { type: 'array', items: row },
  } } : row;
  const encodedRow = { [nullableName]: null, [placeholderName]: null };
  const expectedRow = { [nullableName]: null };
  const text = JSON.stringify(nested ? { 'rows%20/~#é': [encodedRow] } : encodedRow);
  const expected = nested ? { 'rows%20/~#é': [expectedRow] } : expectedRow;
  const transport = codexStrictSchema(original);
  expect(new Ajv().compile(transport)(JSON.parse(text))).toBe(true);
  const normalized = normalizeCodexResponse(text, original);
  validateInferenceResponse(normalized, original);
  expect(JSON.parse(normalized)).toEqual(expected);
  const result = await provider(text, transport).generate({ model: 'chosen', prompt: 'judge', responseSchema: original });
  expect(JSON.parse(result.text)).toEqual(expected);
});

it('does not inspect property names, enum or const data as schema keywords', async () => {
  const literal = { $ref: '#literal', contains: { if: true }, additionalItems: false, default: { not: {} } };
  const original = { type: 'object', additionalProperties: false, properties: {
    $ref: { const: literal }, contains: { enum: [literal] }, additionalItems: { type: 'string' },
  } };
  const encoded = { $ref: literal, contains: literal, additionalItems: null };
  const result = await provider(JSON.stringify(encoded), codexStrictSchema(original)).generate({
    model: 'chosen', prompt: 'judge', responseSchema: original,
  });
  expect(JSON.parse(result.text)).toEqual({ $ref: literal, contains: literal });
});

it('retains unchanged literal constraints and supplies an empty closed object shape', () => {
  const original = { type: 'object', additionalProperties: false, properties: { x: { type: 'string' } },
    required: ['x'], enum: [{ x: 'yes' }], const: { x: 'yes' } };
  expect(codexStrictSchema(original)).toEqual(original);
  expect(normalizeCodexResponse('{"x":"yes"}', original)).toBe('{"x":"yes"}');
  expect(codexStrictSchema({ type: 'object', additionalProperties: false }))
    .toEqual({ type: 'object', additionalProperties: false, properties: {}, required: [] });
});

// Representative extraction wire shape from graders/decomposition/transport.ts;
// no grader internals are imported across the inference ownership boundary.
it('supports the generated draft-07 extraction dialect and bounded semantic arrays', async () => {
  const original = { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false,
    required: ['units', 'ids'], properties: {
      units: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id'], properties: {
        id: { type: 'string', minLength: 1 }, paragraph: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      } } },
      ids: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { type: 'string', enum: ['u1', 'u2'] } },
      reason: { type: 'string', maxLength: 240 },
    } };
  const strict = codexStrictSchema(original);
  expect(strict).not.toHaveProperty('$schema');
  const result = await provider('{"units":[{"id":"u1","paragraph":null}],"ids":["u1"],"reason":null}', strict)
    .generate({ model: 'chosen', prompt: 'judge', responseSchema: original });
  expect(JSON.parse(result.text)).toEqual({ units: [{ id: 'u1' }], ids: ['u1'] });
  for (const ids of [[], ['u1', 'u1'], Array(9).fill('u1')]) {
    await expect(provider(JSON.stringify({ units: [], ids }), strict)
      .generate({ model: 'chosen', prompt: 'judge', responseSchema: original }))
      .rejects.toMatchObject({ kind: 'invalid-response' });
  }
});
