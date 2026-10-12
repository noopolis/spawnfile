import { Ajv } from 'ajv';
import { expect, it, vi } from 'vitest';
import { validateInferenceSchema } from '../response-schema.js';
import { createCodexInference } from './provider.js';
import { codexStrictSchema, normalizeCodexResponse } from './strict-schema.js';

const branch = (type: string) => ({
  type: 'object', additionalProperties: false, properties: { x: { type } },
});
const union = { oneOf: [branch('string'), branch('null')] };
const intersection = { allOf: [branch('string')] };
const ajv = new Ajv({ strict: true, strictRequired: false });
const container = (child: Record<string, unknown>) => ({
  type: 'object', additionalProperties: false, properties: { child },
});

it.each([
  { name: 'overlapping nullable oneOf', schema: union, answer: { x: null } },
  { name: 'allOf omission', schema: intersection, answer: {} },
])('refuses $name despite a valid original answer', ({ schema, answer }) => {
  expect(ajv.compile(schema)(answer)).toBe(true);
  expect(() => codexStrictSchema(schema)).toThrow('cannot preserve');
});

it.each([
  union,
  intersection,
  container(union),
  { type: 'array', items: intersection },
  { anyOf: [{ type: 'null' }, intersection] },
  { $ref: '#/definitions/composed', definitions: { composed: union } },
  { oneOf: [{ $ref: '#/definitions/row' }, { type: 'null' }], definitions: { row: branch('string') } },
  { allOf: [{ $ref: '#/definitions/row' }], definitions: { row: branch('string') } },
  { ...container({ oneOf: [{ $ref: '#/definitions/row' }, { type: 'null' }] }),
    definitions: { row: branch('string') } },
  { ...container({ allOf: [{ $ref: '#/definitions/row' }] }), definitions: { row: branch('string') } },
  { oneOf: [{ type: 'string', minLength: 1 }, { const: '' }] },
  { ...branch('string'), allOf: [{ required: ['x'] }] },
  { ...branch('string'), oneOf: [{ required: ['x'] }, { not: { required: ['x'] } }] },
  { allOf: [{ anyOf: [branch('string'), { type: 'null' }] }] },
])('rejects changed or reference-dependent compositions before any process: %j', async responseSchema => {
  validateInferenceSchema(responseSchema);
  const process = vi.fn(() => { throw new Error('must not launch'); });
  const original = structuredClone(responseSchema);
  await expect(createCodexInference({ process }).generate({
    model: 'chosen', prompt: 'judge', responseSchema,
  })).rejects.toMatchObject({ kind: 'unsupported', message: expect.stringContaining('cannot preserve') });
  expect(process).not.toHaveBeenCalled();
  expect(responseSchema).toEqual(original);
});

it.each([
  {
    schema: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    encoded: null, expected: null,
  },
  {
    schema: { allOf: [{ type: 'string' }, { enum: ['yes', 'no'] }] },
    encoded: 'yes', expected: 'yes',
  },
  {
    schema: { oneOf: [
      { ...branch('string'), required: ['x'] },
      { ...branch('null'), required: ['x'] },
    ] },
    encoded: { x: null }, expected: { x: null },
  },
  {
    schema: { allOf: [{ ...branch('string'), required: ['x'] }] },
    encoded: { x: 'yes' }, expected: { x: 'yes' },
  },
  {
    schema: container({ oneOf: [{ type: 'string' }, { type: 'null' }] }),
    encoded: { child: null }, expected: { child: null },
  },
  {
    schema: { ...container({ $ref: '#/definitions/choice' }), definitions: {
      choice: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    } },
    encoded: { child: null }, expected: { child: null },
  },
  {
    schema: { anyOf: [branch('string'), branch('null')] },
    encoded: { x: null }, expected: { x: null },
  },
  {
    schema: { anyOf: [branch('string'), { type: 'null' }] },
    encoded: { x: null }, expected: {},
  },
  {
    schema: { type: 'object', additionalProperties: false, properties: {
      oneOf: { const: { allOf: [{ $ref: 'literal data' }] } },
    } },
    encoded: { oneOf: { allOf: [{ $ref: 'literal data' }] } },
    expected: { oneOf: { allOf: [{ $ref: 'literal data' }] } },
  },
])('validates encoded responses against the transport before normalization: %j', ({ schema, encoded, expected }) => {
  validateInferenceSchema(schema);
  const translated = codexStrictSchema(schema);
  const validateTransport = ajv.compile(translated);
  expect(validateTransport(encoded), JSON.stringify(validateTransport.errors)).toBe(true);
  const decoded = JSON.parse(normalizeCodexResponse(JSON.stringify(encoded), schema));
  expect(decoded).toEqual(expected);
  expect(ajv.compile(schema)(decoded)).toBe(true);
});
