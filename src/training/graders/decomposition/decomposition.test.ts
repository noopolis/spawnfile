import { describe, expect, it } from 'vitest';
import { parseCheckTemplates, parseCheckTemplatesYaml, parseDecomposition, validateDecomposition,
  instantiateChecks, evidenceRows, normalizeWhitespace, readPath, textLeaves } from './index.js';

import { fixture, receipt } from './fixtures.js';

describe('decomposition formats', () => {
  it('strictly parses typed criteria and YAML; rejects invented schemas/keys', () => {
    const { templates, document } = fixture();
    expect(parseCheckTemplatesYaml('schema: paideia.check-templates.v1\ntemplates:\n- id: x\n  applies_to: sentence\n  type: choice\n  instructions: Check\n  criteria: {a: Good, b: Bad}\n  expected: [a]\n  state: [unit]\n  dimension: clarity\n  severity: minor')).toMatchObject({ context: {} });
    expect(() => parseDecomposition({ ...document, invented: 1 })).toThrow();
    expect(() => parseDecomposition({ ...document, units: [...document.units, ...document.units] })).toThrow('duplicate');
    expect(() => parseCheckTemplates({ ...templates, templates: [...templates.templates, ...templates.templates] })).toThrow('duplicate');
    expect(() => parseCheckTemplates({ ...templates, teachers: [{ id: 'a', provider: 'codex', model: 'x' }, { id: 'a', provider: 'claude', model: 'y' }] })).toThrow('teacher');
    expect(parseCheckTemplates({ ...templates, teachers: [{ id: 'a', provider: 'codex', model: 'x' }] }).teachers).toHaveLength(1);
  });
  it('validates criteria, expected and operator-configured trap semantics', () => {
    const { templates } = fixture();
    const t = templates.templates[0]!;
    const check = (change: object) => parseCheckTemplates({ ...templates, templates: [{ ...t, ...change }] });
    for (const criteria of [{ yes: 'y' }, { abstain: 'a', no: 'b' }, { yes: 'y', no: 'n' }]) expect(() => check({ criteria })).toThrow('criteria');
    expect(() => check({ type: 'score', criteria: { low: 'Low', high: 'High' } })).toThrow('integer');
    expect(check({ type: 'score', criteria: { 0: 'Bad', 1: 'Good' }, expected: [1] }).templates[0]!.expected).toEqual(['1']);
    expect(() => check({ expected: ['absent'] })).toThrow('expected');
    expect(() => check({ expected: [true, true] })).toThrow('expected');
    expect(() => check({ traps: { 'number-substitution': 'unsupported' } })).toThrow('trap answer');
    expect(() => check({ traps: { 'format-paraphrase': true } })).toThrow('trap answer');
    expect(check({ traps: { 'number-substitution': false, 'format-paraphrase': 'unchanged' } })).toBeDefined();
    expect(check({ traps: { 'number-substitution': { answer: false, known_answer: false } } }).templates[0]!.traps)
      .toEqual({ 'number-substitution': { answer: 'false', known_answer: false } });
    expect(check({ traps: { 'number-substitution': { answer: false, known_answer: true } } })).toBeDefined();
    expect(check({ traps: { 'option-permutation': { answer: 'unchanged', known_answer: false } } })).toBeDefined();
    for (const value of [{ answer: 'absent', known_answer: false }, { answer: false },
      { answer: false, known_answer: 'false' }, { answer: false, known_answer: false, extra: true }]) {
      expect(() => check({ traps: { 'number-substitution': value } })).toThrow();
    }
    expect(() => check({ traps: { 'option-permutation': { answer: false, known_answer: false } } })).toThrow('trap answer');
    expect(() => check({ state: ['context.other'] })).toThrow('undeclared');
    expect(() => check({ state: ['secrets'] })).toThrow();
  });
});

describe('evidence validation', () => {
  it('rejects invented default spans without optional paragraph or citation guards', () => {
    const { templates, document, inputs } = fixture();
    document.units = [{ id: 'invented', kind: 'claim', text: 'An entirely fabricated assertion.' }];
    const result = validateDecomposition(document, inputs, templates);
    expect(result.decomposition.units).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
  });
  it('rejects invented spans and undeclared kinds while deriving addresses and citations', () => {
    const { templates, document, inputs } = fixture();
    const original = document.units[0]!;
    const check = (change: object) => validateDecomposition({ ...document, units: [{ ...original, ...change }] }, inputs, templates);
    expect(check({ text: 'Alice\n is  paid 1,000 dollars [R1].' }).rejected).toEqual([]);
    expect(check({ text: 'Alice is paid one million dollars.' }).rejected[0]!.reasons).toContain('text is not a verbatim source span');
    expect(check({ paragraph: 1 }).decomposition.units[0]!.paragraph).toBe(0);
    expect(check({ kind: 'invented' }).rejected).toHaveLength(1);
    expect(check({ cites: ['R9'] }).decomposition.units[0]!.cites).toEqual(['R1']);
    expect(check({ cites: ['R1', 'R1'] }).decomposition.units[0]!.cites).toEqual(['R1']);
    expect(validateDecomposition(document, inputs).rejected).toEqual([]);
    expect(validateDecomposition(document, { ...inputs, context: {} }, templates).rejected).toHaveLength(1);
  });
  it('accepts obligations only from output or assignment and includes audited missed units', () => {
    const { templates, document, inputs } = fixture();
    templates.templates.push({ ...templates.templates[0]!, id: 'coverage', applies_to: 'obligation', instructions: 'Check', state: ['unit'] });
    const obligation = { id: 'o1', kind: 'obligation', text: 'Cover the pay change.' };
    document.audit = { extractor: receipt, at: receipt.at, missed: [obligation] };
    expect(validateDecomposition(document, inputs, templates).rejected).toEqual([]);
    expect(instantiateChecks(templates, document, inputs).map(item => item.id)).toEqual(['supported@c1', 'coverage@o1']);
    document.audit.missed = [{ ...obligation, text: 'Bob was promoted.' }];
    expect(validateDecomposition(document, inputs, templates).rejected).toEqual([]);
    document.audit.missed = [{ ...obligation, text: 'Private instructions.' }];
    expect(validateDecomposition(document, inputs, templates).decomposition.audit!.missed).toEqual([]);
    expect(() => parseDecomposition({ ...document, audit: { ...document.audit, missed: document.units } })).toThrow('duplicate');
  });
  it('handles text leaves, safe paths and exact row boundaries', () => {
    expect(normalizeWhitespace(' a\n\t b ')).toBe('a b');
    expect(textLeaves({ a: null, b: 4, c: ['hello'] })).toEqual([{ path: ['c', '0'], text: 'hello' }]);
    expect(readPath({}, ['constructor'])).toBeUndefined();
    expect(readPath(null, ['x'])).toBeUndefined();
    const { templates, inputs } = fixture();
    expect(evidenceRows(templates, inputs)[0]).toEqual({ id: 'R1', text: '## R1\nAlice is paid 1,000 dollars.\n', context: 'evidence' });
    expect(() => evidenceRows(templates, { ...inputs, context: { evidence: '## R1\n## R1' } })).toThrow('duplicate');
    expect(() => evidenceRows(templates, { ...inputs, context: { evidence: 'a'.repeat(2_000_001) } })).toThrow('oversized');
    expect(evidenceRows({ ...templates, context: {} }, inputs)).toEqual([]);
    const broken = structuredClone(templates); broken.context.evidence!.rows!.heading = '^## (R[0-9]+)?$';
    expect(() => evidenceRows(broken, { ...inputs, context: { evidence: '## ' } })).toThrow('missing');
  });
});

describe('deterministic check instantiation', () => {
  it.each([{ cites: undefined }, { cites: [] }])('renders uncited units as ready with empty cited rows (cites: $cites)', ({ cites }) => {
    const { templates, document, inputs } = fixture();
    document.units = [{ id: 'uncited', kind: 'claim', text: 'Bob was promoted.', ...(cites ? { cites } : {}) }];
    templates.templates[0]!.instructions = 'Check {unit.text} against {unit.cited_rows}.';
    const [instance] = instantiateChecks(templates, document, inputs);
    expect(instance).toMatchObject({ status: 'ready', reasons: [],
      projection: { 'unit.cited_rows': [] }, instructions: 'Check Bob was promoted. against [].' });
  });
  it('keeps unknown derived citation IDs missing', () => {
    const { templates, document, inputs } = fixture();
    const text = 'Bob was promoted [R9].';
    inputs.output = { body: [text] };
    document.units = [{ id: 'unknown', kind: 'claim', text, cites: ['R9'] }];
    templates.templates[0]!.instructions = 'Check {unit.text} against {unit.cited_rows}.';
    const [instance] = instantiateChecks(templates, document, inputs);
    expect(instance).toMatchObject({ status: 'missing' });
    expect(instance!.reasons).toContain('unknown cited row');
    expect(instance!.reasons).toContain('missing state unit.cited_rows');
    expect(instance!.projection).not.toHaveProperty('unit.cited_rows');
  });
  it('keeps uncited units missing when no row structure is declared', () => {
    const { templates, document, inputs } = fixture();
    templates.context = {};
    document.units = [{ id: 'uncited', kind: 'claim', text: 'Bob was promoted.' }];
    templates.templates[0]!.instructions = 'Check {unit.text} against {unit.cited_rows}.';
    const [instance] = instantiateChecks(templates, document, inputs);
    expect(instance).toMatchObject({ status: 'missing' });
    expect(instance!.reasons).toContain('missing state unit.cited_rows');
    expect(instance!.projection).not.toHaveProperty('unit.cited_rows');
  });
  it('renders declared state only, retains digests, and represents missing placeholders/state', () => {
    const { templates, document, inputs } = fixture();
    const template = templates.templates[0]!;
    template.state.push('output.headline', 'context.assignment', 'paragraph', 'neighbors');
    template.instructions += ' {output.headline} {unit}';
    const [instance] = instantiateChecks(templates, document, inputs);
    expect(instance).toMatchObject({ id: 'supported@c1', status: 'ready', options: ['true', 'false'] });
    expect(instance!.projection.neighbors).toEqual({ previous: null, next: 'Bob was promoted.' });
    expect(instance!.instructions).toContain('City update');
    expect(instantiateChecks(templates, document, inputs)[0]!.digest).toBe(instance!.digest);
    template.instructions = '{unit.fields.unknown} {output.secret}';
    expect(instantiateChecks(templates, document, inputs)[0]!.status).toBe('missing');
    template.state.push('output.absent');
    inputs.context.assignment = null;
    expect(instantiateChecks(templates, document, inputs)[0]!.reasons).toContain('missing state output.absent');
  });
  it('fails missing cites/row contexts/paragraphs/conditions instead of skipping', () => {
    const { templates, document, inputs } = fixture();
    const template = templates.templates[0]!;
    document.units[0]!.cites = [];
    expect(instantiateChecks(templates, document, inputs)[0]!.status).toBe('ready');
    document.units[0]!.cites = ['R9'];
    expect(instantiateChecks(templates, document, inputs)[0]!.status).toBe('ready');
    document.units[0]!.cites = ['R1']; inputs.context.evidence = null;
    expect(instantiateChecks(templates, document, inputs)[0]!.reasons.some(reason => reason.includes('row context'))).toBe(true);
    template.state = ['unit', 'paragraph']; delete document.units[0]!.paragraph;
    expect(instantiateChecks(templates, document, inputs)[0]!.reasons).toContain('missing state paragraph');
    template.when = { field: 'modality', equals: 'certain' };
    expect(instantiateChecks(templates, document, inputs)[0]!.status).toBe('missing');
    document.units[0]!.fields!.modality = 'tentative';
    expect(instantiateChecks(templates, document, inputs)[0]!.status).toBe('missing');
    inputs.context.evidence = '## R1\nAlice is paid 1,000 dollars.';
    expect(instantiateChecks(templates, document, inputs)[0]!.status).toBe('missing');
    document.units[0]!.fields!.modality = 'paid';
    expect(instantiateChecks(templates, document, inputs)).toEqual([]);
    document.units[0]!.fields!.modality = 'certain';
    expect(instantiateChecks(templates, document, inputs)).toHaveLength(1);
  });
});

it.each(['missing', 'abstain', 'uncertain', 'unchanged'])('reserves %s for non-answer state', label => {
  const { templates } = fixture();
  templates.templates[0]!.type = 'choice';
  templates.templates[0]!.criteria = { present: 'Present', [label]: 'Not present' };
  templates.templates[0]!.expected = ['present'];
  expect(() => parseCheckTemplates(templates)).toThrow('invalid criteria');
});
