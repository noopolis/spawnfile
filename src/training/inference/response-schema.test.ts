import { describe, expect, it } from 'vitest';
import { validateInferenceResponse, validateInferenceSchema } from './response-schema.js';

const schema = { type: 'object', properties: { 'agents/reporter/AGENTS.md': { type: 'string' } },
  required: ['agents/reporter/AGENTS.md'], additionalProperties: false };

describe('native inference structured response boundary', () => {
  it('accepts exact resource mappings and preserves unstructured requests', () => {
    validateInferenceSchema(schema);
    validateInferenceResponse(JSON.stringify({ 'agents/reporter/AGENTS.md': 'Write clearly.\nUse evidence.' }), schema);
    validateInferenceSchema(undefined);
    validateInferenceResponse('ordinary text', undefined);
  });

  it.each([
    null, [], true, { type: 'imaginary' }, { type: 'string', format: 'not-registered' },
    { $async: true, type: 'object' }, { $ref: 'https://example.invalid/schema.json' },
    { type: 'object', invalidKeyword: true }, { const: Number.NaN }, { const: undefined },
    { const: () => 'not JSON' }, { const: new Date() }, { description: 'x'.repeat(65_537) },
  ])('rejects unsupported schema before native execution: %j', invalid => {
    expect(() => validateInferenceSchema(invalid as unknown as Record<string, unknown>)).toThrow(expect.objectContaining({ kind: 'unsupported' }));
  });

  it.each([
    'I will inspect the files first.', '{}', '{"agents/reporter/AGENTS.md":3}',
    '{"agents/reporter/AGENTS.md":"ok","extra":"changed"}',
    '{"agents/reporter/AGENTS.md":"first","agents/reporter/AGENTS.md":"second"}',
    '```json\n{"agents/reporter/AGENTS.md":"ok"}\n```',
    '{"agents/reporter/AGENTS.md":"ok"} trailing',
  ])('rejects incomplete or mismatched completed text: %s', text => {
    expect(() => validateInferenceResponse(text, schema)).toThrow(expect.objectContaining({ kind: 'protocol' }));
  });

  it('supports local refs, nested constraints and finite JSON only', () => {
    const nested = { type: 'object', properties: { score: { $ref: '#/definitions/score' } }, required: ['score'],
      definitions: { score: { type: 'number', minimum: 0, maximum: 1 } } };
    validateInferenceSchema(nested);
    validateInferenceResponse('{"score":0.9}', nested);
    expect(() => validateInferenceResponse('{"score":2}', nested)).toThrow(expect.objectContaining({ kind: 'protocol' }));
    expect(() => validateInferenceResponse('1e400', {})).toThrow(expect.objectContaining({ kind: 'protocol' }));
  });

  it('rechecks an edited schema instead of trusting cached object identity', () => {
    const mutable = { type: 'string' };
    validateInferenceSchema(mutable);
    mutable.type = 'number';
    expect(() => validateInferenceResponse('"old type"', mutable)).toThrow(expect.objectContaining({ kind: 'protocol' }));
    mutable.type = 'imaginary';
    expect(() => validateInferenceResponse('1', mutable)).toThrow(expect.objectContaining({ kind: 'unsupported' }));
  });
});
