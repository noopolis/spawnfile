import { expect, it } from 'vitest';
import { parseGrader, questionDefinitionDigest } from './format/index.js';
import { expandInstances } from './instances.js';
import { createCalibrationIdentity } from './identity.js';
import { groupLabelInstances, validateStoredVotes } from './labeling/index.js';
import { moveLeadingCitations } from './rows.js';

const rows = { heading: '^### \\[(E\\d+)\\]', cite: '\\[(E\\d+)\\]' };
function rubric(level = 'paragraph', structure: typeof rows & { leading_citations?: string } = rows) {
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

const previous = { ...rows, leading_citations: 'previous' };
const trailingExample = '...back to home bases in the United States. [E1][E7] A US department official confirmed on Sunday that ... [E2] A Pentagon official...';

it('moves trailing citations to the previous sentence in the reported example', () => {
  const instances = expandInstances(rubric('sentence', previous), { body: [trailingExample] },
    { evidence: `${evidence}\n### [E2]\nConfirmation.` });
  expect(instances.map(i => i.unit.text)).toEqual([
    '...back to home bases in the United States. [E1][E7]',
    'A US department official confirmed on Sunday that ... [E2]',
    'A Pentagon official...',
  ]);
  expect(instances.map(i => i.projection.sentence)).toEqual(instances.map(i => i.unit.text));
  expect(instances.map(i => i.state)).toEqual(['ready', 'ready', 'not-applicable']);
  expect(instances.map(i => (i.projection['context.evidence@cited'] as { id: string }[]).map(row => row.id)))
    .toEqual([['E1', 'E7'], ['E2'], []]);
});

it('moves the entire whitespace-separated leading run, retains following text and leaves inline citations', () => {
  const [first, second] = expandInstances(rubric('sentence', previous),
    { body: ['One. [E1]\t [E7] A missile [E1] on Saturday [E3][E5], state media reported Sunday [E4].'] },
    { evidence: `${evidence}\n### [E3]\n### [E5]\n### [E4]` });
  expect(first).toMatchObject({ unit: { text: 'One. [E1]\t [E7]' }, projection: { sentence: 'One. [E1]\t [E7]' } });
  expect(second).toMatchObject({ state: 'ready', unit: { text: 'A missile [E1] on Saturday [E3][E5], state media reported Sunday [E4].' } });
  expect((second!.projection['context.evidence@cited'] as { id: string }[]).map(row => row.id)).toEqual(['E1', 'E3', 'E5', 'E4']);
});

it('keeps the first leading run of every paragraph and absorbs citation-only tails without empty units', () => {
  const instances = expandInstances(rubric('sentence', previous),
    { body: ['[E1] First. [E7]', '[E7] Next paragraph. [E1]'] }, { evidence });
  expect(instances.map(i => [i.key, i.unit.text])).toEqual([
    ['q@p0.s0', '[E1] First. [E7]'], ['q@p1.s0', '[E7] Next paragraph. [E1]'],
  ]);
});

it('keep and the default retain existing sentence units and identities', () => {
  const implicit = rubric('sentence');
  const explicit = rubric('sentence', { ...rows, leading_citations: 'keep' });
  const output = { body: ['One. [E1][E7] Two.'] };
  expect(implicit.context.evidence!.rows!.leading_citations).toBe('keep');
  const instances = expandInstances(implicit, output, { evidence });
  expect(expandInstances(explicit, output, { evidence })).toEqual(instances);
  expect(instances.map(i => [i.unit.text, i.state])).toEqual([
    ['One.', 'not-applicable'], ['[E1][E7] Two.', 'ready'],
  ]);
  expect(() => rubric('sentence', { ...rows, leading_citations: 'next' })).toThrow('context.evidence.rows.leading_citations');
});

it('applies the same adjusted units to sentence-only reads, cited-only reads, predicates and derived questions', () => {
  const base = rubric('sentence', previous);
  const grader = parseGrader({ ...base, questions: [
    { ...base.questions[0], id: 'text', reads: ['sentence'], when: 'Is this a claim?' },
    { ...base.questions[0], id: 'cited', reads: ['context.evidence@cited'] },
    { ...base.questions[0], id: 'predicate', reads: ['sentence'], when: { field: 'sentence', equals: 'One. [E1]' } },
  ] });
  const instances = expandInstances(grader, { body: ['One. [E1] Two.'] }, { evidence });
  for (const id of ['text', 'text.applies', 'cited', 'predicate']) {
    const [first, second] = instances.filter(i => i.questionId === id);
    expect(first).toMatchObject({ state: 'ready', unit: { text: 'One. [E1]' } });
    expect(second!.unit.text).toBe('Two.');
  }
  expect(instances.find(i => i.key === 'predicate@p0.s1')!.state).toBe('not-applicable');
  expect(expandInstances(rubric('paragraph', previous), { body: ['One. [E1] Two.'] }, { evidence })[0]!.unit.text)
    .toBe('One. [E1] Two.');
});

it('pins the setting and cite patterns in every sentence definition and calibration expansion, even with unchanged text', () => {
  const before = rubric('sentence');
  before.questions[0]!.reads = ['sentence'];
  before.questions[0]!.when = 'Does it apply?';
  const after = parseGrader({ ...before, context: { evidence: { description: 'Sources', rows: previous } } });
  const supplied = { backendModel: 'm', golden: 'a'.repeat(64), promptTemplateVersion: 'v', seed: '0', exclusions: [] };
  const original = createCalibrationIdentity(before, supplied);
  const changed = createCalibrationIdentity(after, supplied);
  expect(changed.expansion).not.toEqual(original.expansion);
  for (const id of ['q', 'q.applies']) expect(changed.questions[id]).not.toBe(original.questions[id]);
  const output = { body: ['Claim [E1].'] };
  expect(expandInstances(after, output)[0]!.projectionDigest).toBe(expandInstances(before, output)[0]!.projectionDigest);
  after.context.evidence!.rows!.cite = '(E\\d+)';
  expect(createCalibrationIdentity(after, supplied).expansion).not.toEqual(changed.expansion);
});

it('combines opted-in context patterns and stops at non-whitespace without crossing a kept token', () => {
  const base = rubric('sentence', previous);
  const grader = parseGrader({ ...base, context: { ...base.context,
    plain: { description: 'Unstructured' },
    other: { description: 'Other', rows: { ...previous, cite: '<(X\\d+)>' } },
    kept: { description: 'Kept', rows: { ...rows, cite: '\\{(K\\d+)\\}' } },
  } });
  grader.questions[0]!.reads = ['sentence'];
  expect(expandInstances(grader, { body: ['One. [E1] <X1> Two. {K1}[E7] Three.'] }).map(i => i.unit.text))
    .toEqual(['One. [E1] <X1>', 'Two.', '{K1}[E7] Three.']);
  expect(moveLeadingCitations(['One.', '[E1], [E7] Two.'], [rows.cite]))
    .toEqual(['One. [E1]', ', [E7] Two.']);
});

it('uses exact regex matches, preserves lookbehind context and ignores zero-width matches', () => {
  expect(moveLeadingCitations(['One.', '[E1][E7] Two.'], ['(?<=\\])(\\[E7\\])', '\\[(E1)\\]']))
    .toEqual(['One. [E1][E7]', 'Two.']);
  expect(moveLeadingCitations(['One.', '[E1] Two.'], ['()', rows.cite]))
    .toEqual(['One. [E1]', 'Two.']);
  expect(moveLeadingCitations(['One.', 'Two.'], ['()'])).toEqual(['One.', 'Two.']);
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
