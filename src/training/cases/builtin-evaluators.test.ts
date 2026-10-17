import { describe, expect, it } from 'vitest';
import { builtinEvaluatorDefinitions } from './builtin-evaluators.js';
import { bindingShape, validateBindingReferences, validatePredicate } from './turn-bindings.js';

function validate(name: string, parameters: Record<string, unknown>): void {
  builtinEvaluatorDefinitions[name]!.validate(parameters, name);
}
describe('strict evaluator parameters', () => {
  it.each(['input', 'output', 'total'])('accepts token efficiency metric %s', metric => {
    expect(() => validate('token-efficiency', { metric, target_tokens: 1000 })).not.toThrow();
  });
  it.each([{}, { metric: 'total' }, { target_tokens: 1000 }, { metric: 'cache', target_tokens: 1000 },
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '1000'].map(target_tokens => ({ metric: 'total', target_tokens })),
    { metric: 'total', target_tokens: 1000, extra: true }])('rejects invalid token efficiency parameters %j', parameters => {
    expect(() => validate('token-efficiency', parameters)).toThrow();
  });

  it.each([
    ['equals', { input: 'output.text', value: '' }],
    ['contains-any', { input: 'output.text', values: ['x'] }],
    ['json-schema', { input: 'output.text', schema: 'schema.json' }],
    ['json-schema', { input: 'output.text', schema: { type: 'object' } }],
    ['tool-called', { tool: 'validate', outcome: 'succeeded', phase: 'completion' }],
    ['tool-count', { tool: 'validate', exactly: 1 }],
    ['tool-count', { tool: 'validate', at_least: 1, at_most: 3 }],
    ['tool-sequence', { order: 'happens-before', ending_at: { artifact: 'file', event: 'accepted-call' }, steps: [{ tool: 'validate', where: { cel: 'call.success && call.result.valid' }, bind: { article: 'call.args.article' } }, { tool: 'file', where: { cel: 'call.args.article == bindings.article' } }] }],
    ['llm-rubric', { input: 'output.text', evidence: 'input:files', judge: 'judge', minimum: 0.8, rubric: { prompt: 'Grade.' } }],
    ['llm-rubric', { input: 'output.text', judge: 'judge', minimum: 0.8, rubric: { file: 'rubric.md' } }],
    ['embedding-similarity', { input: 'output.text', reference: 'input:files', provider: 'local', model: 'model', metric: 'cosine', calibration: 'human-v1', minimum: 0.8 }],
  ])('accepts authored %s contract', (name, value) => expect(() => validate(name, value)).not.toThrow());
  it.each([
    ['equals', { input: 'output.text' }],
    ['tool-called', { tool: 'validate', outcome: 'maybe' }],
    ['tool-count', { tool: 'validate' }],
    ['tool-count', { tool: 'validate', exactly: 1, at_least: 0 }],
    ['tool-count', { tool: 'validate', exactly: 1.5 }],
    ['tool-count', { tool: 'validate', at_least: 3, at_most: 2 }],
    ['tool-sequence', { order: 'arrival', steps: [{ tool: 'x' }] }],
    ['tool-sequence', { order: 'happens-before', steps: [{ tool: 'x', bind: { x: 'call.secret' } }] }],
    ['tool-sequence', { order: 'happens-before', steps: [{ tool: 'x', bind: { x: 'call.args' } }, { tool: 'y', bind: { x: 'call.result' } }] }],
    ['tool-sequence', { order: 'happens-before', steps: [{ tool: 'x', where: { cel: 'process.exit()' } }] }],
    ['llm-rubric', { input: 'output.text', judge: 'judge', minimum: 0.8, rubric: { prompt: 'Grade.', file: 'rubric.md' } }],
    ['embedding-similarity', { input: 'output.text', reference: 'input:files', provider: 'local', model: 'model', metric: 'made-up', calibration: 'v1', minimum: 0.8 }],
  ])('rejects unsupported or ambiguous %s contract', (name, value) => expect(() => validate(name, value)).toThrow());
});
describe('trusted multi-wake binding authoring', () => {
  const declaration = { event: 'tool.complete', distinct: 'call.id', cardinality: 'one', value: 'call.result', where: { cel: 'call.success && call.tool == "research"' } };
  it('accepts typed trusted selectors and scoped CEL', () => {
    bindingShape({ request: declaration }, '$');
    bindingShape({ output: { event: 'output', distinct: 'event.id', cardinality: 'one', value: 'event.text', where: { cel: 'event.text == "ready"' } } }, '$');
    validateBindingReferences({ message: { json: { request: { binding: 'request.request_id' }, copy: [null, true, 3] } } }, new Set(['request']), '$');
    validatePredicate('call.success', ['call'], '$');
  });
  it.each([
    {},
    { 'bad.name': declaration },
    { request: { ...declaration, extra: true } },
    { request: { ...declaration, event: 'invented' } },
    { request: { ...declaration, distinct: 'message.id' } },
    { request: { ...declaration, cardinality: 'any' } },
    { request: { ...declaration, value: 'process.env' } },
    { request: { ...declaration, event: 'output' } },
    { request: { ...declaration, event: 'output', distinct: 'event.id' } },
    { request: { ...declaration, where: { cel: 'ambient.secret == true' } } },
  ])('rejects invalid observation claims', value => expect(() => bindingShape(value, '$')).toThrow());
  it('rejects malformed, non-boolean or excessive predicates before launching the subject', () => {
    for (const expression of ['call.', '1', ' '.repeat(16_001)]) expect(() => validatePredicate(expression, ['call'], '$')).toThrow();
  });
  it('rejects forward, ambiguous, executable and missing typed references', () => {
    for (const value of [{ binding: 'future.id' }, { binding: 'request.id', fallback: 'fake' }, { binding: 'request[x]' }]) {
      expect(() => validateBindingReferences(value, new Set(['request']), '$')).toThrow();
    }
  });
});

it.each([
  ['word-count', { input: 'artifact:article#/body', min: 0, max: 200, ignore: [] }],
  ['word-count', { input: ['output.text', 'context:grounding'], max: 100 }],
  ['values-in-source', { input: 'output.text', source: ['sources/facts.md', 'input:files'], max_missing: 0 }],
])('accepts deterministic text check %s', (name, parameters) => expect(() => validate(name, parameters)).not.toThrow());

it.each([
  ['word-count', {}], ['word-count', { input: 'output.text' }],
  ['word-count', { input: [], min: 1 }], ['word-count', { input: 'artifact:a#bad', min: 1 }],
  ['word-count', { input: 'bad', min: 1 }], ['word-count', { input: 4, min: 1 }],
  ['word-count', { input: 'output.text', min: -1 }], ['word-count', { input: 'output.text', max: 1.5 }],
  ['word-count', { input: 'output.text', min: 2, max: 1 }],
  ['word-count', { input: 'output.text', max: Infinity }],
  ['word-count', { input: 'output.text', max: 1, unexpected: true }],
  ['word-count', { input: 'output.text', min: 1, ignore: ['['] }],
  ['word-count', { input: 'output.text', min: 1, ignore: [3] }],
  ['word-count', { input: 'output.text', min: 1, ignore: 'x' }],
  ['values-in-source', { input: 'output.text' }], ['values-in-source', { input: 'output.text', source: [] }],
  ['values-in-source', { input: 'output.text', source: '../facts.md' }],
  ['values-in-source', { input: 'output.text', source: '/facts.md' }],
  ['values-in-source', { input: 'output.text', source: 'facts.md', max_missing: -1 }],
  ['values-in-source', { input: 'output.text', source: 'facts.md', max_missing: 0.5 }],
  ['values-in-source', { input: 'output.text', source: 'facts.md', unexpected: true }],
])('rejects malformed deterministic check %s %j', (name, parameters) => expect(() => validate(name, parameters)).toThrow());

it('rejects malformed source selectors', () => expect(() => validate('values-in-source', { input: 'output.text', source: 'artifact:a#bad' })).toThrow('source selector'));
