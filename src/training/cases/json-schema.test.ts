import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { builtinEvaluatorDefinitions, compileJsonSchema, parseDatasetYaml, resolveDataset } from './index.js';

function document(schema: unknown, extraChecks: unknown[] = []) {
  return parseDatasetYaml(JSON.stringify({ schema: 'paideia.dataset.v1', id: 'shape',
    checks: [...extraChecks, { id: 'valid', eval: 'json-schema', input: 'output.text', schema }],
    records: [{ id: 'one', input: { prompt: 'A response' } }, { id: 'two', input: { prompt: 'Another response' } }] }));
}

it('accepts ordinary required-only schemas and gives the changed policy a new evaluator version', () => {
  const schema = { type: 'object', required: ['title', 'author'], properties: { id: { type: 'string' } } };
  const original = structuredClone(schema);
  const resolved = resolveDataset(document(schema));
  expect(resolved.registryVersions['evaluator:json-schema']).toBe('2');
  expect(builtinEvaluatorDefinitions['equals']!.version).toBe('1');
  expect(resolved.sharedStages[0]!.checks[0]!.schema).toEqual(original);
  expect(schema).toEqual(original);
});

it.each([{ type: 'not-a-type' }, { type: 'object', requried: ['title'] },
  { $ref: '#/$defs/missing' }, { required: 'title' }, { type: 'object', properties: { n: { minimum: 1 } } }])(
  'rejects malformed schemas, unresolved references and other strictness violations before execution (%j)', schema => {
    expect(() => resolveDataset(document(schema))).toThrow();
  });

it.each(['{not JSON', '\uFEFF{"type":"object"}', '{"type":"not-a-type"}', '{"type":"object","requried":["title"]}', '{"$ref":"#/$defs/missing"}'])(
  'compiles protected sidecar contents during resolution (%s)', bytes => {
    expect(() => resolveDataset(document('schema.json'), { readCriterionFile: () => bytes })).toThrow();
  });

it('compiles the exact copied bytes being hashed and reads each criterion file once', () => {
  const bytes = Buffer.from('{"type":"object","required":["title"]}\n');
  const read = vi.fn().mockReturnValueOnce(bytes).mockReturnValue('{"type":"broken"}');
  const resolved = resolveDataset(document('schema.json'), { readCriterionFile: read });
  expect(read).toHaveBeenCalledTimes(1);
  expect(resolved.criterionFileDigests['schema.json']).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
  expect(resolved.registryVersions['evaluator:json-schema']).toBe('2');
});

it('cannot bypass schema compilation by first using the same file as a rubric', () => {
  const rubric = { id: 'prose', eval: 'llm-rubric', input: 'output.text', judge: 'editor', minimum: 0.5, rubric: { file: 'shared.json' } };
  expect(() => resolveDataset(document('shared.json', [rubric]), {
    registry: { judges: { editor: { version: '1' } } }, readCriterionFile: () => '{"$ref":"#/$defs/missing"}',
  })).toThrow();
});

it('never coerces input, inserts defaults or removes properties during structural validation', () => {
  const schema = { type: 'object', required: ['count'], additionalProperties: false,
    properties: { count: { type: 'integer', default: 9 } } };
  const original = structuredClone(schema);
  const validator = compileJsonSchema(schema);
  for (const value of [{ count: '3' }, { count: 3, extra: true }, {}]) {
    const before = structuredClone(value);
    expect(validator(value)).toBe(false);
    expect(value).toEqual(before);
  }
  expect(schema).toEqual(original);
});
