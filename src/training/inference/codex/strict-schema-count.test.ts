import { Ajv } from 'ajv';
import { expect, it, vi } from 'vitest';
import { validateInferenceSchema } from '../response-schema.js';
import { createCodexInference } from './provider.js';
import { codexStrictSchema, normalizeCodexResponse } from './strict-schema.js';

const limited = {
  type: 'object', additionalProperties: false, maxProperties: 1,
  properties: { x: { type: 'string' }, y: { type: 'string' } },
};
const ajv = new Ajv({ strict: true, strictRequired: false });

it('refuses a satisfiable schema whose transport placeholders exceed maxProperties', () => {
  validateInferenceSchema(limited);
  expect(ajv.compile(limited)({})).toBe(true);
  expect(ajv.compile(limited)({ x: 'yes' })).toBe(true);
  expect(() => codexStrictSchema(limited)).toThrow('cannot preserve maxProperties');
});

it.each([
  { name: 'root', schema: limited },
  { name: 'zero limit', schema: { ...limited, maxProperties: 0 } },
  { name: 'nullable object', schema: { ...limited, type: ['object', 'null'] } },
  { name: 'nested property', schema: { type: 'object', additionalProperties: false, properties: { child: limited } } },
  { name: 'array items', schema: { type: 'array', items: limited } },
  { name: 'union branch', schema: { anyOf: [limited, { type: 'null' }] } },
  { name: 'reference target', schema: { $ref: '#/definitions/limited', definitions: { limited } } },
  { name: 'reference sibling', schema: { type: 'object', maxProperties: 1, $ref: '#/$defs/row',
    $defs: { row: { type: 'object', additionalProperties: false, properties: limited.properties } } } },
  { name: 'schema dependency', schema: { type: 'object', additionalProperties: false,
    properties: limited.properties, dependencies: { x: { maxProperties: 1 } } } },
  { name: 'tuple tail', schema: { type: 'array', minItems: 1, maxItems: 1, items: [true], additionalItems: limited } },
])('rejects maxProperties in $name before any provider process', async ({ schema }) => {
  validateInferenceSchema(schema);
  const original = structuredClone(schema);
  const process = vi.fn(() => { throw new Error('must not launch'); });
  await expect(createCodexInference({ process }).generate({
    model: 'chosen', prompt: 'judge', responseSchema: schema,
  })).rejects.toMatchObject({ kind: 'unsupported', message: expect.stringContaining('maxProperties') });
  expect(process).not.toHaveBeenCalled();
  expect(schema).toEqual(original);
});

it('preserves maxProperties as a property name or literal data', () => {
  const schema = { type: 'object', additionalProperties: false, properties: {
    maxProperties: { const: { maxProperties: 1 } },
    literal: { enum: [{ maxProperties: 0 }] },
  } };
  const encoded = { maxProperties: { maxProperties: 1 }, literal: { maxProperties: 0 } };
  validateInferenceSchema(schema);
  expect(ajv.compile(codexStrictSchema(schema))(encoded)).toBe(true);
  const decoded = JSON.parse(normalizeCodexResponse(JSON.stringify(encoded), schema));
  expect(decoded).toEqual(encoded);
  expect(ajv.compile(schema)(decoded)).toBe(true);
});
