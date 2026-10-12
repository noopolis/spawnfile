import { Ajv } from 'ajv';
import { expect, it, vi } from 'vitest';
import { validateInferenceResponse, validateInferenceSchema } from '../response-schema.js';
import { createCodexInference } from './provider.js';
import { codexStrictSchema, normalizeCodexResponse } from './strict-schema.js';

const row = { type: 'object', additionalProperties: false, properties: { x: { type: 'string' } } };
const ajv = new Ajv({ strict: true, strictRequired: false });

it.each([
  { name: 'enum omission', schema: { ...row, enum: [{}] }, answer: {} },
  { name: 'const omission', schema: { ...row, const: {} }, answer: {} },
  { name: 'negated string bound', schema: { type: 'string', not: { type: 'string', minLength: 1 } }, answer: '' },
  { name: 'enum array ancestor', schema: { type: 'array', items: row, enum: [[{}]] }, answer: [{}] },
  { name: 'const object ancestor', schema: { type: 'object', additionalProperties: false,
    required: ['row'], properties: { row }, const: { row: {} } }, answer: { row: {} } },
  { name: 'negated reference', schema: { type: 'string', not: { $ref: '#/definitions/nonempty' },
    definitions: { nonempty: { type: 'string', minLength: 1 } } }, answer: '' },
  { name: 'enum reference target', schema: { $ref: '#/definitions/row', enum: [{}], definitions: { row } }, answer: {} },
  { name: 'nested enum', schema: { type: 'array', items: { ...row, enum: [{}] } }, answer: [{}] },
  { name: 'bounded primitive enum', schema: { type: 'string', minLength: 1, enum: ['yes'] }, answer: 'yes' },
  { name: 'conditional optional slot', schema: { ...row, if: { required: ['x'] }, then: false }, answer: {} },
  { name: 'conditional else slot', schema: { ...row, if: { required: ['x'] }, then: false, else: true }, answer: {} },
  { name: 'conditional predicate bound', schema: { type: 'string', if: { minLength: 1 }, then: false }, answer: '' },
  { name: 'conditional then rewrite', schema: { type: 'string', if: true, then: { minLength: 1 } }, answer: 'yes' },
  { name: 'conditional else rewrite', schema: { type: 'string', if: false, else: { minLength: 1 } }, answer: 'yes' },
  { name: 'nested conditional', schema: { type: 'array', items: { ...row, if: { required: ['x'] }, then: false } }, answer: [{}] },
  { name: 'referenced conditional', schema: { $ref: '#/definitions/row', definitions: {
    row: { ...row, if: { required: ['x'] }, then: false },
  } }, answer: {} },
  { name: 'conditional predicate reference', schema: { type: 'string', if: { $ref: '#/definitions/nonempty' }, then: false,
    definitions: { nonempty: { type: 'string', minLength: 1 } } }, answer: '' },
])('refuses $name before inference despite a valid original answer', async ({ schema, answer }) => {
  validateInferenceSchema(schema);
  expect(ajv.compile(schema)(answer)).toBe(true);
  const original = structuredClone(schema);
  expect(() => codexStrictSchema(schema)).toThrow('cannot preserve');
  expect(() => normalizeCodexResponse(JSON.stringify(answer), schema)).toThrow('cannot preserve');
  const process = vi.fn(() => { throw new Error('must not launch'); });
  await expect(createCodexInference({ process }).generate({ model: 'chosen', prompt: 'judge', responseSchema: schema }))
    .rejects.toMatchObject({ kind: 'unsupported', message: expect.stringContaining('cannot preserve') });
  expect(process).not.toHaveBeenCalled();
  expect(schema).toEqual(original);
});

const anchored = {
  type: 'object', additionalProperties: false, required: ['row'],
  properties: { row: { $ref: '#row' } }, definitions: { row: { $id: '#row', ...row } },
};

it.each([
  { name: 'local anchor', schema: anchored },
  { name: 'identifier reached by pointer', schema: { ...anchored, properties: { row: { $ref: '#/definitions/row' } } } },
  { name: 'root identifier', schema: { $id: 'https://example.invalid/schema', ...row } },
  { name: 'URI-encoded pointer', schema: { ...anchored,
    properties: { row: { $ref: '#/definitions/%72ow' } }, definitions: { row } } },
])('refuses $name consistently before inference and normalization', async ({ schema }) => {
  validateInferenceSchema(schema);
  const original = structuredClone(schema);
  const answer = schema === anchored ? { row: {} } : {};
  if (schema === anchored) expect(ajv.compile(schema)(answer)).toBe(true);
  expect(() => codexStrictSchema(schema)).toThrow('unscoped local JSON pointer');
  expect(() => normalizeCodexResponse('{"row":{"x":null}}', schema)).toThrow('unscoped local JSON pointer');
  const process = vi.fn(() => { throw new Error('must not launch'); });
  await expect(createCodexInference({ process }).generate({ model: 'chosen', prompt: 'judge', responseSchema: schema }))
    .rejects.toMatchObject({ kind: 'unsupported', message: expect.stringContaining('unscoped local JSON pointer') });
  expect(process).not.toHaveBeenCalled();
  expect(schema).toEqual(original);
});

it.each([
  { schema: { type: 'string', if: { const: 'yes' }, then: { enum: ['yes'] }, else: { const: 'no' } },
    encoded: 'yes', expected: 'yes' },
  { schema: { type: 'string', if: { const: 'yes' }, then: { enum: ['yes'] }, else: { const: 'no' } },
    encoded: 'no', expected: 'no' },
  { schema: { ...row, required: ['x'], if: { required: ['x'] }, then: true, else: false },
    encoded: { x: 'yes' }, expected: { x: 'yes' } },
  { schema: { type: 'object', additionalProperties: false, properties: {
    if: { const: { if: true, then: false, else: { minLength: 1 } } }, then: { type: 'string' }, else: { type: 'string' },
  } }, encoded: { if: { if: true, then: false, else: { minLength: 1 } }, then: null, else: null },
    expected: { if: { if: true, then: false, else: { minLength: 1 } } } },
  { schema: { type: 'string', not: { const: 'no' } }, encoded: 'yes', expected: 'yes' },
  { schema: { ...row, required: ['x'], enum: [{ x: 'yes' }] }, encoded: { x: 'yes' }, expected: { x: 'yes' } },
  { schema: { ...row, required: ['x'], const: { x: 'yes' } }, encoded: { x: 'yes' }, expected: { x: 'yes' } },
  { schema: { type: 'object', additionalProperties: false, properties: {
    $id: { const: { $id: '#literal', $ref: '#literal', not: { minLength: 1 } } },
  } }, encoded: { $id: { $id: '#literal', $ref: '#literal', not: { minLength: 1 } } },
  expected: { $id: { $id: '#literal', $ref: '#literal', not: { minLength: 1 } } } },
  { schema: { type: 'object', additionalProperties: false, required: ['row'],
    properties: { row: { $ref: '#/definitions/a~1b~0c' } }, definitions: { 'a/b~c': row } },
  encoded: { row: { x: null } }, expected: { row: {} } },
])('preserves supported constraints and literal data: %j', ({ schema, encoded, expected }) => {
  validateInferenceSchema(schema);
  expect(ajv.compile(codexStrictSchema(schema))(encoded)).toBe(true);
  const decoded = normalizeCodexResponse(JSON.stringify(encoded), schema);
  expect(JSON.parse(decoded)).toEqual(expected);
  validateInferenceResponse(decoded, schema);
});
