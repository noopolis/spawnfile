import { expect, it } from 'vitest';
import { parseGrader, questionDefinitionDigest } from './format/index.js';
import { expandInstances } from './instances.js';
import { createCalibrationIdentity } from './identity.js';
import { groupLabelInstances, validateStoredVotes } from './labeling/index.js';

const rows = { heading: '^### \\[(E\\d+)\\]', cite: '\\[(E\\d+)\\]' };
function rubric(level = 'paragraph', structure = rows) {
  return parseGrader({ schema: 'paideia.grader.v1', id: 'rows', golden: 'labels.yaml', calibration: 'cal.json',
    context: { evidence: { description: 'Sources', rows: structure } },
    teachers: [{ id: 't', provider: 'claude', model: 'm' }], model: { backend: 'teacher', teacher: 't' },
    escalate: { to: 't', between: [0.3, 0.7] }, score: { method: 'weighted' },
    questions: [{ id: 'q', type: 'yes-no', expected: 'yes', level,
      reads: [level, 'context.evidence@cited'] }] });
}
const evidence = 'Private preamble\n### [E1] First\nFirst fact.\n### [E7] Second\nSecond fact.\n### [E9] Uncited\nHidden.';

it('splits whole heading lines, excludes preamble and uncited rows, deduplicates adjacent citations in source order', () => {
  const [instance] = expandInstances(rubric(), { body: ['Claim [E7][E1][E7].'] }, { evidence });
  expect(instance).toMatchObject({ state: 'ready', unit: { paragraph: 0, text: 'Claim [E7][E1][E7].' },
    projection: { paragraph: 'Claim [E7][E1][E7].', 'context.evidence@cited': [
      { id: 'E1', text: '### [E1] First\nFirst fact.\n' },
      { id: 'E7', text: '### [E7] Second\nSecond fact.\n' },
    ] } });
  expect(JSON.stringify(instance!.projection)).not.toMatch(/Private|Uncited|Hidden/);
});

it('uses each sentence alone for citations and returns one instance per sentence', () => {
  const instances = expandInstances(rubric('sentence'), { body: ['One [E1]. Two [E7]!', 'Uncited.'] }, { evidence });
  expect(instances.map(({ key, state, unit }) => ({ key, state, unit }))).toEqual([
    { key: 'q@p0.s0', state: 'ready', unit: { paragraph: 0, sentence: 0, text: 'One [E1].' } },
    { key: 'q@p0.s1', state: 'ready', unit: { paragraph: 0, sentence: 1, text: 'Two [E7]!' } },
    { key: 'q@p1.s0', state: 'not-applicable', unit: { paragraph: 1, sentence: 0, text: 'Uncited.' } },
  ]);
  expect(instances.map(i => i.projection['context.evidence@cited'])).toEqual([
    [{ id: 'E1', text: '### [E1] First\nFirst fact.\n' }],
    [{ id: 'E7', text: '### [E7] Second\nSecond fact.\n' }], [],
  ]);
});

it.each([
  ['unknown id', '[E2]', evidence, 'unknown cited row id: E2'],
  ['duplicate id', '[E1]', `${evidence}\n### [E1] Duplicate`, 'duplicate row id E1'],
  ['no heading', '[E1]', 'Preamble only.', 'unknown cited row id: E1'],
  ['nontext context', '[E1]', {}, 'row context must be a string'],
  ['missing context', '[E1]', undefined, 'missing path evidence'],
])('marks %s missing', (_name, text, source, reason) => {
  expect(expandInstances(rubric(), { body: [text] }, { evidence: source })[0]).toMatchObject({
    state: 'missing', reasons: [`context.evidence@cited: ${reason}`],
  });
});

it('marks uncited units not applicable and validates duplicate ids even for uncited units', () => {
  expect(expandInstances(rubric(), { body: ['No citations.'] }, { evidence: '' })[0]!.state).toBe('not-applicable');
  expect(expandInstances(rubric(), { body: ['No citations.'] }, { evidence: '### [E1]\n### [E1]' })[0]!.state).toBe('missing');
});

it('supports generic named captures, lookarounds, escaped parentheses and CRLF without leaking preamble', () => {
  const structure = { heading: '^(?:ROW)\\((?<id>[a-z]+)\\)(?=:)', cite: '(?<=ref:)([a-z]+)(?![a-z])' };
  // A noncapturing group, lookahead and escaped parentheses must not count as captures.
  const [instance] = expandInstances(rubric('paragraph', structure), { body: ['ref:cat'] },
    { evidence: 'Preamble\r\nROW(cat): label\r\nFact\r\nROW(dog): other' });
  expect(instance!.projection['context.evidence@cited']).toEqual([{ id: 'cat', text: 'ROW(cat): label\r\nFact\r\n' }]);
});

it.each(['[', '(a)(b)', '(?:a)', '\\(a\\)', '[(a)]', 'a'.repeat(201)])('refuses invalid regex %s at parse with a field path', regex => {
  for (const field of ['heading', 'cite'] as const) {
    expect(() => rubric('paragraph', { ...rows, [field]: regex })).toThrow(`context.evidence.rows.${field}`);
  }
});

it('refuses cited reads at article level, on unstructured/unknown context, and in article predicates', () => {
  expect(() => rubric('article')).toThrow('reads');
  const grader = rubric();
  for (const context of [{ evidence: { description: 'plain' } }, {}]) {
    expect(() => parseGrader({ ...grader, context })).toThrow('reads');
  }
  expect(() => parseGrader({ ...grader, questions: [{ ...grader.questions[0], level: 'article', reads: [],
    when: { field: 'context.evidence@cited', equals: [] } }] })).toThrow('when.field');
});

it('fails missing for captures that match without an id, including empty and optional captures', () => {
  for (const heading of ['^### (E1)?', '^### ()']) {
    expect(expandInstances(rubric('paragraph', { ...rows, heading }), { body: ['[E1]'] }, { evidence: '### ' })[0])
      .toMatchObject({ state: 'missing', reasons: ['context.evidence@cited: row heading has no row id'] });
  }
  for (const cite of ['(E1)?', '()']) {
    expect(expandInstances(rubric('paragraph', { ...rows, cite }), { body: ['x'] }, { evidence })[0])
      .toMatchObject({ state: 'missing', reasons: ['context.evidence@cited: citation has no row id'] });
  }
});

it('uses cited predicates mechanically and propagates missing/not applicable states', () => {
  const grader = rubric();
  grader.questions[0]!.when = { field: 'context.evidence@cited', equals: [] };
  expect(expandInstances(grader, { body: ['No refs.'] }, { evidence })[0]!.state).toBe('not-applicable');
  expect(expandInstances(grader, { body: ['[E1]'] }, {})[0]!.state).toBe('missing');
});

it.each(['heading', 'cite'] as const)('pins %s regex in definition, calibration expansion and human vote identity even when projection is unchanged', field => {
  const original = rubric();
  const changed = rubric('paragraph', { ...rows, [field]: `(?:${rows[field]})` });
  const supplied = { backendModel: 'm', golden: 'a'.repeat(64), promptTemplateVersion: 'v', seed: '0', exclusions: [] };
  const before = createCalibrationIdentity(original, supplied);
  const after = createCalibrationIdentity(changed, supplied);
  expect(after.questions).not.toEqual(before.questions);
  expect(after.expansion).not.toEqual(before.expansion);
  const output = { body: ['Claim [E1].'] };
  const entry = groupLabelInstances(original, output, { evidence })[0]!.instances[0]!;
  expect(entry.instance.definitionDigest).toBe(questionDefinitionDigest(original, entry.question));
  expect(expandInstances(changed, output, { evidence })[0]!.projectionDigest).toBe(entry.instance.projectionDigest);
  const labels = { schema: 'paideia.labels.v1' as const, grader: 'rows', labelers: { human: { kind: 'human' as const, name: 'Reader' } },
    labels: [{ id: 'one', lineage: 'one', output, context: { evidence }, votes: { 'q@p0': { human: 'yes' } },
      provenance: { human: { votes: { 'q@p0': { question_digest: entry.instance.definitionDigest, projection_digest: entry.instance.projectionDigest } } } } }] };
  expect(() => validateStoredVotes(original, labels, { resolved: true })).not.toThrow();
  expect(() => validateStoredVotes(changed, labels, { resolved: true })).toThrow('Stale vote');
});
