import { expect, it, vi } from 'vitest';
import { createCodexInference } from './provider.js';
import { codexStrictSchema, normalizeCodexResponse } from './strict-schema.js';

type Schema = Record<string, unknown>;
const row = { type: 'object', additionalProperties: false, properties: { x: { type: 'string' } } };
// This inventory is intentionally independent of the implementation allowlist.
const refused: Schema = {
  $id: '#anchor', $anchor: 'anchor', $dynamicRef: '#anchor', $dynamicAnchor: 'anchor',
  contains: row, additionalItems: row, prefixItems: [row], patternProperties: { '^x': row },
  if: row, then: row, else: row, not: row, dependentSchemas: { x: row },
  unevaluatedProperties: row, unevaluatedItems: row, dependencies: { x: row }, dependentRequired: { x: ['y'] },
  propertyNames: { type: 'string' }, anyOf: [row], oneOf: [row], allOf: [row],
  maxProperties: 1, minProperties: 1, minContains: 1, maxContains: 1,
  exclusiveMinimum: 0, exclusiveMaximum: 1, multipleOf: 2, pattern: '^x', format: 'email',
  title: 'Row', $comment: 'Row', default: { properties: { child: row } }, examples: [row],
  readOnly: true, writeOnly: true, deprecated: true, contentSchema: row,
  contentEncoding: 'base64', contentMediaType: 'application/json', nullable: true, unknownFutureKeyword: row,
};
const placements = [
  { name: 'root', path: '#', wrap: (node: Schema) => node },
  { name: 'property', path: '#/properties/a~1b~0c', wrap: (node: Schema) => ({
    ...row, properties: { 'a/b~c': node },
  }) },
  { name: 'items', path: '#/items', wrap: (node: Schema) => ({ type: 'array', items: node }) },
  { name: 'deep items/property', path: '#/properties/rows/items/properties/child/items', wrap: (node: Schema) => ({
    ...row, properties: { rows: { type: 'array', items: {
      ...row, properties: { child: { type: 'array', items: node } },
    } } },
  }) },
];

it.each(Object.entries(refused).flatMap(([keyword, value]) => placements.map(placement => ({
  keyword, ...placement, value,
}))))('refuses $keyword at $name with the keyword and exact path', async ({ keyword, value, path, wrap }) => {
  const schema = wrap({ ...row, [keyword]: value });
  const original = structuredClone(schema);
  const error = { kind: 'unsupported', message: `Codex strict schema refuses ${keyword} at ${path}/${keyword}: keyword is not allowlisted` };
  expect(() => codexStrictSchema(schema)).toThrow(expect.objectContaining(error));
  expect(() => normalizeCodexResponse('{}', schema)).toThrow(expect.objectContaining(error));
  const process = vi.fn(() => { throw new Error('must not launch'); });
  await expect(createCodexInference({ process }).generate({ model: 'chosen', prompt: 'judge', responseSchema: schema }))
    .rejects.toMatchObject(error);
  expect(process).not.toHaveBeenCalled();
  expect(schema).toEqual(original);
});

it.each([
  null, [], true, { const: undefined }, { const: () => 'not JSON' }, { const: new Date() },
  { const: Number.NaN }, { description: 'x'.repeat(65_537) },
  { type: 'string', minimum: 0 },
])('retains generic schema validation before launch: %j', async schema => {
  const process = vi.fn(() => { throw new Error('must not launch'); });
  await expect(createCodexInference({ process }).generate({
    model: 'chosen', prompt: 'judge', responseSchema: schema as unknown as Schema,
  })).rejects.toMatchObject({
    kind: 'unsupported',
    message: 'Response schema must be a synchronous JSON Schema draft-07 object with locally resolvable references (at most 64 KiB)',
  });
  expect(process).not.toHaveBeenCalled();
});

it.each([
  { schema: { $ref: '#/$defs/target', ...row, $defs: { target: row } }, keyword: '$ref' },
  { schema: { ...row, $defs: { unused: { contains: row } } }, keyword: 'contains' },
  { schema: { ...row, default: { $ref: '#/$defs/target', contains: row } }, keyword: 'default' },
  { schema: { type: 'array', additionalItems: row, items: [true], minItems: 1, maxItems: 1 }, keyword: 'additionalItems' },
  { schema: { ...row, properties: { x: { type: 'array', contains: row } } }, keyword: 'contains' },
])('refuses unsupported containers/references before any process: $keyword', async ({ schema, keyword }) => {
  const process = vi.fn(() => { throw new Error('must not launch'); });
  await expect(createCodexInference({ process }).generate({ model: 'chosen', prompt: 'judge', responseSchema: schema }))
    .rejects.toMatchObject({ kind: 'unsupported', message: expect.stringContaining(keyword) });
  expect(process).not.toHaveBeenCalled();
});

it.each([
  { schema: { items: [row] }, keyword: 'items' },
  { schema: { items: true }, keyword: 'items' },
  { schema: { properties: { x: false } }, keyword: 'schema' },
  { schema: { properties: [] }, keyword: 'properties' },
  { schema: { type: ['string', 'number'] }, keyword: 'type' },
  { schema: { type: ['null', 'null'] }, keyword: 'type' },
  { schema: { type: 'unknown' }, keyword: 'type' },
  { schema: { required: ['x', 'x'] }, keyword: 'required' },
  { schema: { required: [1] }, keyword: 'required' },
  { schema: { description: { contains: row } }, keyword: 'description' },
  { schema: { $schema: 'https://json-schema.org/draft/2020-12/schema' }, keyword: '$schema' },
  { schema: { enum: [] }, keyword: 'enum' },
  { schema: { minimum: Infinity }, keyword: 'minimum' },
  { schema: { maximum: '1' }, keyword: 'maximum' },
  { schema: { minLength: -1 }, keyword: 'minLength' },
  { schema: { maxItems: 1.5 }, keyword: 'maxItems' },
  { schema: { uniqueItems: {} }, keyword: 'uniqueItems' },
  { schema: { ...row, required: ['missing'] }, keyword: 'required' },
  { schema: { type: 'object' }, keyword: 'additionalProperties' },
  { schema: { ...row, additionalProperties: true }, keyword: 'additionalProperties' },
  { schema: { ...row, additionalProperties: { type: 'string' } }, keyword: 'additionalProperties' },
])('refuses unsupported keyword values: $keyword', ({ schema, keyword }) => {
  expect(() => codexStrictSchema(schema)).toThrow(`Codex strict schema refuses ${keyword} at #`);
});

it.each([
  { ...row, enum: [{}] }, { ...row, const: {} },
  { type: 'array', items: row, enum: [[{}]] },
  { type: 'object', additionalProperties: false, required: ['child'], properties: { child: row }, const: { child: {} } },
  { type: 'array', items: row, uniqueItems: true },
])('refuses literal constraints intersecting a translated subtree: %j', schema => {
  expect(() => codexStrictSchema(schema)).toThrow('cannot preserve literal constraints');
  expect(() => normalizeCodexResponse('{}', schema)).toThrow('cannot preserve literal constraints');
});
