import { Ajv } from 'ajv';
import { expect, it, vi } from 'vitest';
import { validateInferenceResponse, validateInferenceSchema } from '../response-schema.js';
import { createCodexInference } from './provider.js';
import { codexStrictSchema, normalizeCodexResponse } from './strict-schema.js';

const row = { type: 'object', additionalProperties: false, properties: { x: { type: 'string' } } };
const ajv = new Ajv({ strict: true, strictRequired: false });
const constraints = [
  { keyword: 'dependencies', constraint: { dependencies: { x: false } } },
  { keyword: 'dependencies', constraint: { dependencies: { x: ['y'] } } },
  { keyword: 'propertyNames', constraint: { propertyNames: { enum: ['y'] } } },
  { keyword: 'propertyNames', constraint: { propertyNames: false } },
];

for (const { keyword, constraint } of constraints) {
  const constrained = { ...row, ...constraint };
  it.each([
    { name: 'root', schema: constrained, answer: {} },
    { name: 'nullable object', schema: { ...constrained, type: ['object', 'null'] }, answer: {} },
    { name: 'nested property', schema: { type: 'object', additionalProperties: false,
      properties: { child: constrained } }, answer: { child: {} } },
    { name: 'array items', schema: { type: 'array', items: constrained }, answer: [{}] },
    { name: 'union branch', schema: { anyOf: [constrained, { type: 'null' }] }, answer: {} },
    { name: 'reference target', schema: { $ref: '#/definitions/row', definitions: { row: constrained } }, answer: {} },
    { name: 'reference sibling', schema: { type: 'object', ...constraint, $ref: '#/$defs/row',
      $defs: { row } }, answer: {} },
    { name: 'tuple tail', schema: { type: 'array', minItems: 1, maxItems: 1, items: [true], additionalItems: constrained },
      answer: [true] },
  ])(`refuses ${keyword} in $name before inference despite a valid original answer`, async ({ schema, answer }) => {
    validateInferenceSchema(schema);
    expect(ajv.compile(schema)(answer)).toBe(true);
    const original = structuredClone(schema);
    expect(() => codexStrictSchema(schema)).toThrow(`cannot preserve ${keyword}`);
    expect(() => normalizeCodexResponse(JSON.stringify(answer), schema)).toThrow(`cannot preserve ${keyword}`);
    const process = vi.fn(() => { throw new Error('must not launch'); });
    await expect(createCodexInference({ process }).generate({ model: 'chosen', prompt: 'judge', responseSchema: schema }))
      .rejects.toMatchObject({ kind: 'unsupported', message: expect.stringContaining(`cannot preserve ${keyword}`) });
    expect(process).not.toHaveBeenCalled();
    expect(schema).toEqual(original);
  });
}

it.each(['dependencies', 'propertyNames'])('preserves %s as a property name and literal data', keyword => {
  const schema = { type: 'object', additionalProperties: false, properties: {
    [keyword]: { const: { [keyword]: false } },
    literal: { enum: [{ [keyword]: { x: false } }] },
  } };
  const encoded = { [keyword]: { [keyword]: false }, literal: { [keyword]: { x: false } } };
  validateInferenceSchema(schema);
  expect(ajv.compile(codexStrictSchema(schema))(encoded)).toBe(true);
  const decoded = normalizeCodexResponse(JSON.stringify(encoded), schema);
  expect(JSON.parse(decoded)).toEqual(encoded);
  validateInferenceResponse(decoded, schema);
});
