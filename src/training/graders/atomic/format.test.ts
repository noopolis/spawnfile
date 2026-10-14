import { expect, it } from 'vitest';
import { parseAtomicGrader, parseAtomicGraderYaml, validateAtomicTemplates } from './format.js';
import { parseCheckTemplates } from '../decomposition/index.js';

const declaration = { schema: 'paideia.atomic-grader.v1', id: 'quality', templates: 'templates.yaml',
  extractor: { provider: 'codex', model: 'test' }, decision: { backend: 'typesafe', model: 'jev-1.0.0', max_spend_usd: 1 }, missing: 'fail',
  aggregation: { method: 'gates-times-coverage-times-quality', critical_pass_at: 0.8, pass_at: 0.5, obligation_kinds: ['obligation'],
    dimensions: { coverage: { weight: 1, budget: 1 } }, penalties: { critical: 1, major: 0.5, minor: 0.1 } } };

it('strictly parses the public file and defaults the extraction deadline and compact feedback', () => {
  const parsed = parseAtomicGrader(declaration);
  expect(parsed.extractor.deadline_ms).toBe(900_000);
  expect(parsed.feedback).toEqual({ max_checks: 20, max_unit_chars: 300, max_bytes: 8000, failure_threshold: 0.8 });
  expect(parseAtomicGraderYaml(JSON.stringify(declaration))).toEqual(parsed);
  expect(parseAtomicGrader({ ...declaration, extractor: { ...declaration.extractor, deadline_ms: 1500 } }).extractor.deadline_ms).toBe(1500);
  for (const change of [{ credentials: 'refused' }, { decision: { ...declaration.decision, key: 'refused' } },
    { extractor: { provider: 'claude', model: 'test' } }, { decision: { ...declaration.decision, backend: 'jev-http' } },
    { decision: { ...declaration.decision, model: 'jev-latest' } }, { decision: { ...declaration.decision, max_spend_usd: -1 } },
    { extractor: { ...declaration.extractor, deadline_ms: 0 } }, { missing: 'skip' }, { feedback: { max_bytes: 100 } },
  ]) expect(() => parseAtomicGrader({ ...declaration, ...change })).toThrow();
  for (const templates of ['/absolute', '../escape', './file', 'C:/file', 'a\\b', 'a//b', 'a\0b']) {
    expect(() => parseAtomicGrader({ ...declaration, templates })).toThrow();
  }
  expect(() => parseAtomicGrader({ ...declaration, gates: [{ id: 'g', check: {} }, { id: 'g', check: {} }] })).toThrow('duplicate atomic gate');
  expect(() => parseAtomicGrader({ ...declaration, aggregation: { ...declaration.aggregation, dimensions: {} } })).toThrow('empty');
  expect(() => parseAtomicGrader({ ...declaration, aggregation: { ...declaration.aggregation, obligation_kinds: ['obligation', 'obligation'] } })).toThrow('duplicate obligation');
  expect(() => parseAtomicGrader({ ...declaration, gates: [{ id: 'g', check: { eval: 'tool-called' } }] })).toThrow('unbound tool');
});

it('checks dimension budgets and obligation families before inference', () => {
  const grader = parseAtomicGrader(declaration);
  const template = { id: 'covered', applies_to: 'obligation', type: 'choice', instructions: 'Covered?', criteria: { yes: 'Yes', no: 'No' },
    expected: ['yes'], state: ['unit'], dimension: 'coverage', severity: 'major' };
  const templates = parseCheckTemplates({ schema: 'paideia.check-templates.v1', templates: [template] });
  expect(() => validateAtomicTemplates(grader, templates)).not.toThrow();
  expect(() => validateAtomicTemplates(grader, { ...templates, templates: [{ ...templates.templates[0]!, dimension: 'undeclared' }] })).toThrow('undeclared dimension');
  expect(() => validateAtomicTemplates(grader, { ...templates, templates: [{ ...templates.templates[0]!, applies_to: 'claim' }] })).toThrow('ungraded obligation');
});

it('admits only supported Codex effort controls', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh']) {
    expect(parseAtomicGrader({ ...declaration, extractor: { ...declaration.extractor, effort } }).extractor.effort).toBe(effort);
  }
  expect(() => parseAtomicGrader({ ...declaration, extractor: { ...declaration.extractor, effort: 'max' } })).toThrow();
});

it.each([['score', 10], ['choice', 255]] as const)('checks the TypeSafe %s option boundary during preflight', (type, limit) => {
  const grader = parseAtomicGrader(declaration);
  const templates = (count: number) => parseCheckTemplates({ schema: 'paideia.check-templates.v1', templates: [{
    id: 'covered', applies_to: 'obligation', type, instructions: 'Covered?',
    criteria: Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i), `Anchor ${i}`])),
    expected: ['0'], state: ['unit'], dimension: 'coverage', severity: 'major',
  }] });
  expect(() => validateAtomicTemplates(grader, templates(limit))).not.toThrow();
  expect(() => validateAtomicTemplates(grader, templates(limit + 1))).toThrow('TypeSafe');
});
