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

const referenceSiblings = {
  type: 'object', additionalProperties: false, properties: { x: false },
  $ref: '#/$defs/empty', $defs: { empty: {} },
};

const containsRow = { type: 'object', additionalProperties: false, properties: { x: false } };
const containsArray = { type: 'array', items: true, minItems: 1, maxItems: 1, contains: containsRow };

it.each([
  { name: 'direct predicate', schema: containsArray, answer: [{}] },
  { name: 'referenced predicate', schema: { ...containsArray,
    contains: { $ref: '#/$defs/row' }, $defs: { row: containsRow } }, answer: [{}] },
  { name: 'nested property', schema: container(containsArray), answer: { child: [{}] } },
  { name: 'reference target', schema: { $ref: '#/$defs/array',
    $defs: { array: containsArray } }, answer: [{}] },
  { name: 'reference to tuple tail', schema: { $ref: '#/$defs/holder/additionalItems',
    $defs: { holder: { type: 'array', items: [true], minItems: 1, maxItems: 1,
      additionalItems: containsArray } } }, answer: [{}] },
])('refuses contains in $name before inference', async ({ schema, answer }) => {
  validateInferenceSchema(schema);
  expect(ajv.compile(schema)(answer)).toBe(true);
  const original = structuredClone(schema);
  expect(() => codexStrictSchema(schema)).toThrow('cannot preserve contains');
  expect(() => normalizeCodexResponse(JSON.stringify(answer), schema)).toThrow('cannot preserve contains');
  const process = vi.fn(() => { throw new Error('must not launch'); });
  await expect(createCodexInference({ process }).generate({ model: 'chosen', prompt: 'judge', responseSchema: schema }))
    .rejects.toMatchObject({ kind: 'unsupported', message: expect.stringContaining('cannot preserve contains') });
  expect(process).not.toHaveBeenCalled();
  expect(schema).toEqual(original);
});

it('preserves contains as a property name and literal or annotation data', () => {
  const schema = { type: 'object', additionalProperties: false, properties: {
    contains: { const: { contains: containsRow } },
    literal: { enum: [{ contains: false }] },
  }, default: { contains: containsRow } };
  const encoded = { contains: { contains: containsRow }, literal: { contains: false } };
  const original = structuredClone(schema);
  validateInferenceSchema(schema);
  const translated = codexStrictSchema(schema);
  expect(translated['default']).toEqual(schema.default);
  expect(ajv.compile(translated)(encoded)).toBe(true);
  const decoded = JSON.parse(normalizeCodexResponse(JSON.stringify(encoded), schema));
  expect(decoded).toEqual(encoded);
  expect(ajv.compile(schema)(decoded)).toBe(true);
  expect(schema).toEqual(original);
});

const referenceSiblingCases = [
  { name: 'root optional false property', schema: referenceSiblings, answer: {} },
  { name: 'nested property', schema: container(referenceSiblings), answer: { child: {} } },
  { name: 'array item', schema: { type: 'array', items: referenceSiblings }, answer: [{}] },
  { name: 'union branch', schema: { anyOf: [referenceSiblings, { type: 'null' }] }, answer: {} },
].map(test => ({ ...test, schema: { ...test.schema, $defs: { empty: {} } } }));

it.each([
  ...referenceSiblingCases,
  {
    name: 'reference to tuple tail',
    schema: {
      type: 'object', additionalProperties: false, required: ['child'],
      properties: { child: { $ref: '#/$defs/holder/additionalItems' } },
      $defs: {
        row: { type: 'object', additionalProperties: false, properties: { x: false } },
        holder: {
          type: 'array', items: [true], minItems: 1, maxItems: 1,
          additionalItems: {
            $ref: '#/$defs/row',
            type: 'object', additionalProperties: false, properties: { x: false },
          },
        },
      },
    },
    answer: { child: {} },
  },
])('refuses reference sibling constraints in $name before inference', async ({ schema, answer }) => {
  validateInferenceSchema(schema);
  expect(ajv.compile(schema)(answer)).toBe(true);
  const original = structuredClone(schema);
  expect(() => codexStrictSchema(schema)).toThrow('cannot preserve $ref sibling constraints');
  expect(() => normalizeCodexResponse(JSON.stringify(answer), schema)).toThrow('cannot preserve $ref sibling constraints');
  const process = vi.fn(() => { throw new Error('must not launch'); });
  await expect(createCodexInference({ process }).generate({ model: 'chosen', prompt: 'judge', responseSchema: schema }))
    .rejects.toMatchObject({ kind: 'unsupported', message: expect.stringContaining('$ref sibling constraints') });
  expect(process).not.toHaveBeenCalled();
  expect(schema).toEqual(original);
});

it('preserves reference metadata, target normalization and literal $ref siblings', () => {
  const schema = {
    $ref: '#/definitions/row', title: 'Row', description: 'A referenced row',
    $comment: 'Annotation', default: {}, examples: [{}], readOnly: true, writeOnly: false,
    definitions: { row: { type: 'object', additionalProperties: false, properties: {
      x: false, data: { const: { $ref: '#literal', properties: false } },
    } } },
  };
  const encoded = { x: null, data: { $ref: '#literal', properties: false } };
  expect(ajv.compile(codexStrictSchema(schema))(encoded)).toBe(true);
  const decoded = JSON.parse(normalizeCodexResponse(JSON.stringify(encoded), schema));
  expect(decoded).toEqual({ data: encoded.data });
  expect(ajv.compile(schema)(decoded)).toBe(true);
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

const annotationTarget = {
  $ref: '#/$defs/row', type: 'object', additionalProperties: false, properties: { x: false },
};

it.each([
  { $ref: '#/default', default: annotationTarget },
  { $ref: '#/examples/0', examples: [annotationTarget] },
  { $ref: '#/default/properties/child', default: { properties: { child: annotationTarget } } },
  { $ref: '#/$defs/holder/const', $defs: { holder: { const: annotationTarget } } },
  { $ref: '#/$defs/holder/enum/0', $defs: { holder: { enum: [annotationTarget] } } },
  { $ref: '#/$defs/alias', $defs: { alias: { $ref: '#/default' } }, default: annotationTarget },
])('refuses reference targets outside schema locations: %j', async input => {
  const schema = { ...input, $defs: {
    ...input.$defs, row: { type: 'object', additionalProperties: false, properties: { x: false } },
  } };
  validateInferenceSchema(schema);
  expect(ajv.compile(schema)({})).toBe(true);
  const original = structuredClone(schema);
  expect(() => codexStrictSchema(schema)).toThrow('requires $ref targets at supported schema locations');
  expect(() => normalizeCodexResponse('{}', schema)).toThrow('requires $ref targets at supported schema locations');
  const process = vi.fn(() => { throw new Error('must not launch'); });
  await expect(createCodexInference({ process }).generate({ model: 'chosen', prompt: 'judge', responseSchema: schema }))
    .rejects.toMatchObject({ kind: 'unsupported', message: expect.stringContaining('supported schema locations') });
  expect(process).not.toHaveBeenCalled();
  expect(schema).toEqual(original);
});

it('preserves schema-looking annotation data without inspecting its references', () => {
  const schema = {
    $ref: '#/$defs/row', default: annotationTarget, examples: [annotationTarget],
    $defs: { row: { type: 'object', additionalProperties: false, properties: { x: false } } },
  };
  const original = structuredClone(schema);
  const strict = codexStrictSchema(schema);
  expect(strict['default']).toEqual(annotationTarget);
  expect(strict['examples']).toEqual([annotationTarget]);
  expect(ajv.compile(strict)({ x: null })).toBe(true);
  expect(normalizeCodexResponse('{"x":null}', schema)).toBe('{}');
  expect(schema).toEqual(original);
});

it.each([
  { type: 'array', items: { $ref: '#' } },
  { $ref: '#/$defs/a', $defs: {
    a: { type: 'array', items: { $ref: '#/$defs/b' } },
    b: { type: 'array', items: { $ref: '#/$defs/a' } },
  } },
  { type: 'array', items: { $ref: '#/$defs/allowed' }, $defs: { allowed: true } },
  { type: 'array', items: { $ref: '#/$defs/forbidden' }, $defs: { forbidden: false } },
])('admits recursive and boolean references at schema locations: %j', schema => {
  validateInferenceSchema(schema);
  expect(codexStrictSchema(schema)).toEqual(schema);
  expect(normalizeCodexResponse('[]', schema)).toBe('[]');
});
