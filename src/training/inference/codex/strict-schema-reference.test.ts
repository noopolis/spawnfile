import { Ajv } from 'ajv';
import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { validateInferenceResponse, validateInferenceSchema } from '../response-schema.js';
import { createCodexInference } from './provider.js';
import { codexStrictSchema, normalizeCodexResponse } from './strict-schema.js';

type Schema = Record<string, unknown>;
function roundTrip(schema: Schema, encoded: unknown, expected: unknown): void {
  const original = structuredClone(schema);
  validateInferenceSchema(schema);
  expect(new Ajv().compile(codexStrictSchema(schema))(encoded)).toBe(true);
  const normalized = normalizeCodexResponse(JSON.stringify(encoded), schema);
  validateInferenceResponse(normalized, schema);
  expect(JSON.parse(normalized)).toEqual(expected);
  expect(schema).toEqual(original);
}

it.each(['definitions', '$defs'])('restores %s enum references through the provider', async keyword => {
  const schema = { type: 'object', additionalProperties: false, required: ['answer'],
    properties: { answer: { $ref: `#/${keyword}/answer` } },
    [keyword]: { answer: { type: 'string', enum: ['yes', 'no'] } } };
  roundTrip(schema, { answer: 'yes' }, { answer: 'yes' });
  expect(codexStrictSchema(schema)).toEqual(schema);
  let text = '{"answer":"yes"}';
  const process = vi.fn(options => ({
    write: async () => undefined, endInput: () => undefined,
    stop: async () => { throw new Error('unexpected stop'); },
    completion: (async () => {
      if (options.args.includes('status')) return { exitCode: 0, stderr: 'Logged in using ChatGPT', cancelled: false };
      const file = options.args[options.args.indexOf('--output-schema') + 1];
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(schema);
      for (const event of [
        { type: 'thread.started', thread_id: 't', model: 'reported' }, { type: 'turn.started' },
        { type: 'item.completed', item: { id: 'a', type: 'agent_message', text } },
        { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
      ]) await options.onLine(JSON.stringify(event), new AbortController().signal);
      return { exitCode: 0, stderr: '', cancelled: false };
    })(),
  }));
  const provider = createCodexInference({ process });
  const request = { model: 'chosen', prompt: 'judge', responseSchema: schema };
  expect(await provider.generate(request)).toMatchObject({ text, model: 'reported', usage: { inputTokens: 10 } });
  expect(process).toHaveBeenCalledTimes(2);
  text = '{"answer":"maybe"}';
  await expect(provider.generate(request)).rejects.toMatchObject({ kind: 'invalid-response', usage: { inputTokens: 10 } });
});

it('translates referenced objects and preserves nullable referenced values through aliases', () => {
  const schema = { type: 'object', additionalProperties: false, properties: {
    row: { $ref: '#/definitions/alias', description: 'Optional row' },
    kept: { $ref: '#/definitions/nullable' }, removed: { $ref: '#/definitions/answer' },
  }, definitions: {
    alias: { $ref: '#/definitions/row' },
    row: { type: 'object', additionalProperties: false, properties: {
      answer: { $ref: '#/definitions/answer' }, kept: { $ref: '#/definitions/nullable' },
    } },
    answer: { type: 'string', minLength: 1 }, nullable: { type: ['string', 'null'] },
  } };
  roundTrip(schema, { row: { answer: null, kept: null }, kept: null, removed: null }, { row: { kept: null }, kept: null });
  roundTrip(schema, { row: null, kept: null, removed: 'yes' }, { kept: null, removed: 'yes' });
  const invalid = normalizeCodexResponse('{"removed":""}', schema);
  expect(() => validateInferenceResponse(invalid, schema)).toThrow('does not match');
});

it('supports root references, escaped pointer targets and literal percent/hash names', () => {
  const schema = { $ref: '#/$defs/a~1b~0c', $defs: {
    'a/b~c': { type: 'object', additionalProperties: false, properties: {
      'a%20b': { type: ['string', 'null'] }, 'a b': { type: 'string' },
      'a#é/~': { $ref: '#/$defs/answer' },
    } }, answer: { type: 'string' },
  } };
  roundTrip(schema, { 'a%20b': null, 'a b': null, 'a#é/~': null }, { 'a%20b': null });
});

it('normalizes recursive root references in arrays without recursing during admission', () => {
  const schema = { type: 'object', additionalProperties: false, properties: {
    label: { type: 'string' }, children: { type: 'array', items: { $ref: '#' } },
  } };
  roundTrip(schema, { label: null, children: [{ label: 'child', children: null }] }, { children: [{ label: 'child' }] });
});

it('supports local references to property and item schema locations', () => {
  const schema = { type: 'object', additionalProperties: false, properties: {
    answer: { type: 'string', enum: ['yes', 'no'] },
    alias: { $ref: '#/properties/answer' },
    rows: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { x: { type: 'string' } } } },
    row: { $ref: '#/properties/rows/items' },
  } };
  roundTrip(schema, { answer: 'yes', alias: 'no', rows: [{ x: null }], row: { x: null } },
    { answer: 'yes', alias: 'no', rows: [{}], row: {} });
});

it('admits references nested under definitions and metadata-only siblings', () => {
  const schema = { $ref: '#/definitions/answer', description: 'An answer',
    $schema: 'http://json-schema.org/draft-07/schema#', definitions: {
      answer: { $ref: '#/definitions/answer/definitions/value', definitions: {
        value: { type: 'string', enum: ['yes', 'no'] },
      } },
    } };
  roundTrip(schema, 'yes', 'yes');
});

it.each([
  { $ref: 'https://example.com/schema' }, { $ref: '#anchor' }, { $ref: '#/definitions/a%20b' },
  { $ref: 1 }, { $ref: '#/definitions/a~2b' }, { $ref: '#/missing' },
  { $ref: '#/definitions' , definitions: {} },
  { $ref: '#/enum/0', enum: [{ type: 'string' }] },
  { type: 'object', additionalProperties: false, properties: { x: { $ref: '#/enum/0' } }, enum: [{ type: 'string' }] },
  { $ref: '#/definitions/a', type: 'string', definitions: { a: { type: 'string' } } },
  { $ref: '#' }, { $ref: '#/definitions/a', definitions: { a: { $ref: '#/definitions/b' }, b: { $ref: '#/definitions/a' } } },
  { definitions: [] }, { $defs: { unused: { contains: { type: 'string' } } } },
  { definitions: { unused: { type: 'object' } } },
])('refuses unsafe reference schemas before process launch: %j', async schema => {
  expect(() => codexStrictSchema(schema)).toThrow(expect.objectContaining({ kind: 'unsupported' }));
  expect(() => normalizeCodexResponse('{}', schema)).toThrow(expect.objectContaining({ kind: 'unsupported' }));
  const process = vi.fn(() => { throw new Error('must not launch'); });
  await expect(createCodexInference({ process }).generate({ model: 'chosen', prompt: 'judge', responseSchema: schema }))
    .rejects.toMatchObject({ kind: 'unsupported' });
  expect(process).not.toHaveBeenCalled();
});

it.each(['enum', 'const', 'uniqueItems'])('refuses %s constraints enclosing references to translated targets', keyword => {
  const schema = { type: 'array', items: { $ref: '#/definitions/row' },
    [keyword]: keyword === 'enum' ? [[{}]] : keyword === 'const' ? [{}] : true,
    definitions: { row: { type: 'object', additionalProperties: false, properties: { x: { type: 'string' } } } } };
  expect(() => codexStrictSchema(schema)).toThrow('cannot preserve literal constraints');
});
