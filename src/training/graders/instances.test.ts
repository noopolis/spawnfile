import { describe, expect, it } from 'vitest';
import { parseGrader } from './format/index.js';
import { expandInstances, segmenterIdentity } from './instances.js';

function grader(questions: unknown[], gates: unknown[] = []) {
  return parseGrader({ schema: 'paideia.grader.v1', id: 'test', golden: 'golden.yaml', calibration: 'cal.json',
    context: { evidence: { description: 'Evidence' } }, teachers: [{ id: 't', provider: 'claude', model: 'model' }],
    model: { backend: 'teacher', teacher: 't' }, escalate: { to: 't', between: [0.3, 0.7] },
    gates, questions: questions.map(question => ({ id: 'q', type: 'yes-no', expected: 'yes', reads: [], ...question as object })),
    score: { method: 'weighted' } });
}

describe('grader instance expansion', () => {
  it('expands article reads without exposing undeclared output or context', () => {
    const instance = expandInstances(grader([{ reads: ['output.title.text', 'context.evidence'] }]),
      { title: { text: 'A title', hidden: 'secret' }, extra: 'private' }, { evidence: ['fact'], hidden: 'secret' })[0]!;
    expect(instance).toMatchObject({ key: 'q', questionId: 'q', level: 'article', state: 'ready', reasons: [],
      projection: { 'output.title.text': 'A title', 'context.evidence': ['fact'] } });
    expect(Object.keys(instance.projection)).toEqual(['output.title.text', 'context.evidence']);
  });

  it('projects paragraphs and their neighbors, using null at boundaries', () => {
    const instances = expandInstances(grader([{ level: 'paragraph', reads: ['paragraph', 'previous-paragraph', 'next-paragraph'] }]),
      { body: [' First. ', 'Second.'] });
    expect(instances.map(instance => instance.key)).toEqual(['q@p0', 'q@p1']);
    expect(instances[0]!.projection).toEqual({ paragraph: ' First. ', 'previous-paragraph': null, 'next-paragraph': 'Second.' });
    expect(instances[1]!.projection).toEqual({ paragraph: 'Second.', 'previous-paragraph': ' First. ', 'next-paragraph': null });
  });

  it('segments trimmed sentences, dropping empty units, with stable zero-based keys', () => {
    const instances = expandInstances(grader([{ level: 'sentence', reads: ['sentence', 'paragraph'] }]),
      { body: ['  One sentence. Two!   ', '   ', 'Third?'] });
    expect(instances.map(instance => instance.key)).toEqual(['q@p0.s0', 'q@p0.s1', 'q@p2.s0']);
    expect(instances.map(instance => instance.projection.sentence)).toEqual(['One sentence.', 'Two!', 'Third?']);
    expect(segmenterIdentity()).toContain(`icu=${process.versions.icu}`);
  });

  it.each([{}, { body: [] }, { body: 'not an array' }])('marks zero paragraphs missing, never N/A: %j', output => {
    const instances = expandInstances(grader([{ level: 'paragraph', when: { field: 'output.applies', equals: true } }]), output);
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({ key: 'q', state: 'missing', reasons: ['output.body has no units'] });
  });

  it('marks empty sentence collections missing', () => {
    expect(expandInstances(grader([{ level: 'sentence' }]), { body: ['   ', ''] })[0])
      .toMatchObject({ state: 'missing', reasons: ['output.body has no sentence units'] });
  });

  it.each(['paragraph', 'sentence'])('retains malformed %s units as missing', level => {
    const instances = expandInstances(grader([{ level, reads: [] }]), { body: [42, 'Fine.'] });
    expect(instances[0]).toMatchObject({ state: 'missing', reasons: ['output.body.0 is not a paragraph string'] });
    expect(instances[1]!.state).toBe('ready');
  });

  it('marks absent, undefined, primitive and inherited paths missing; null remains a value', () => {
    const rubric = grader([{ reads: ['output.title', 'output.nested.text', 'context.evidence'] }]);
    const output = Object.assign(Object.create({ title: 'inherited' }) as object, { nested: 12 });
    const missing = expandInstances(rubric, output, { evidence: undefined })[0]!;
    expect(missing.state).toBe('missing');
    expect(missing.reasons).toEqual(['output.title: missing path title', 'output.nested.text: missing path nested.text',
      'context.evidence: missing path evidence']);
    expect(expandInstances(grader([{ reads: ['output.title'] }]), { title: null })[0]!.projection).toEqual({ 'output.title': null });
    expect(expandInstances(rubric, null)[0]!.state).toBe('missing');
  });

  it('evaluates structured equals/in mechanically, without adding fields to the projection', () => {
    const rubric = grader([{ id: 'yes', when: { field: 'output.kind', equals: { a: 1, b: 2 } } },
      { id: 'in', when: { field: 'context.evidence', in: ['fact', 'proof'] } },
      { id: 'no', reads: ['output.absent'], when: { field: 'output.kind', equals: 'other' } }]);
    const instances = expandInstances(rubric, { kind: { b: 2, a: 1 } }, { evidence: 'proof' });
    expect(instances.map(instance => instance.state)).toEqual(['ready', 'ready', 'not-applicable']);
    expect(instances.every(instance => Object.keys(instance.projection).length === 0)).toBe(true);
    expect(expandInstances(rubric, {})[0]!.state).toBe('missing');
    expect(expandInstances(rubric, { kind: 'other' }, { evidence: 'rumor' })[1]!.state).toBe('not-applicable');
  });

  it('uses local fields for structured applicability', () => {
    const instances = expandInstances(grader([{ level: 'paragraph', when: { field: 'paragraph', equals: 'Applies.' } }]),
      { body: ['Applies.', 'Other.'] });
    expect(instances.map(instance => instance.state)).toEqual(['ready', 'not-applicable']);
  });

  it('derives applicability questions for natural-language when at every level and for gates', () => {
    const rubric = grader([{ id: 'article', when: 'The article discusses money.' },
      { id: 'sentence', level: 'sentence', reads: ['sentence'], when: 'The sentence claims a fact.' }],
    [{ id: 'gate', type: 'yes-no', expected: 'yes', reads: [], when: 'This is a claim.' }]);
    const instances = expandInstances(rubric, { body: ['A fact.'] });
    expect(instances.find(instance => instance.key === 'article')!.dependsOn).toBe('article.applies');
    expect(instances.find(instance => instance.key === 'sentence@p0.s0')!.dependsOn).toBe('sentence.applies@p0.s0');
    expect(instances.find(instance => instance.key === 'gate')!.dependsOn).toBe('gate.applies');
    expect(instances.filter(instance => instance.questionId.endsWith('.applies'))).toHaveLength(3);
  });

  it('digests only projections with stable key order and changes when read evidence changes', () => {
    const rubric = grader([{ id: 'a', reads: ['output.title', 'context.evidence'] },
      { id: 'b', reads: ['context.evidence', 'output.title'] }]);
    const instances = expandInstances(rubric, { title: 'Title' }, { evidence: { a: 1, b: 2 } });
    expect(instances[0]!.projectionDigest).toBe(instances[1]!.projectionDigest);
    const changed = expandInstances(rubric, { title: 'Different' }, { evidence: { b: 2, a: 1 } });
    expect(changed[0]!.projectionDigest).not.toBe(instances[0]!.projectionDigest);
  });
});
