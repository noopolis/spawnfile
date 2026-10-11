import { describe, expect, it } from 'vitest';
import { adjudicationInstability, leaveOneTeacherOut, referenceQuality } from './metrics.js';
import type { CheckReference, CouncilOutput, TrapAssessment } from './types.js';

function check(adjudication: string[] = []): CheckReference {
  return { digest: 'x', template_id: 'support', teachers: { a: { answer: 'yes' }, b: { answer: 'no' } },
    distribution: { yes: 0.5, no: 0.5 }, unknown_mass: 0, adjudication: adjudication.map(answer => answer === 'uncertain' ? { answer: null, status: 'uncertain' as const } : { answer }), final: !adjudication.length || adjudication.every(answer => answer === 'yes') ? 'yes' : null, status: adjudication.length ? 'adjudicated' : 'agreed' };
}
function output(checks: CheckReference[]): CouncilOutput {
  return { outputDigest: 'output', identity: 'identity', digest: 'digest', complete: true,
    checks: Object.fromEntries(checks.map((value, index) => [index, value])), calls: [], skipped: [] };
}
const correct: TrapAssessment = { outputId: 'output', kind: 'number-substitution', templateId: 'support', intended: 'no', actual: 'no', baseline: 'yes' };
const control: TrapAssessment = { outputId: 'output', kind: 'option-permutation', templateId: 'support', intended: 'unchanged', actual: 'no', baseline: 'no' };
const population = { outputIds: ['output'] };
describe('council quality gate', () => {
  it('counts uncertain as an answer and uses all ready checks as the instability denominator', () => {
    const outputs = [output([check(), check(['yes', 'yes']), check(['yes', 'no']), check(['uncertain', 'uncertain']), check(['uncertain', 'yes'])])];
    expect(adjudicationInstability(outputs)).toEqual({ items: 5, unstable: 3, rate: 0.6 });
    expect(adjudicationInstability([output([check(['yes'])])])).toEqual({ items: 1, unstable: 1, rate: 1 });
    expect(adjudicationInstability([])).toEqual({ items: 0, unstable: 0, rate: 0 });
  });
  it('fails closed without traps and counts missing/uncertain against every intended instance', () => {
    expect(referenceQuality([], []).gate).toBe('STOP');
    const quality = referenceQuality([], [correct, { ...correct, actual: null }, { ...correct, templateId: 'other', actual: 'uncertain' }]);
    expect(quality.knownAnswer).toEqual({ total: 3, correct: 1, accuracy: 1 / 3 });
    expect(quality.insufficientKinds).toEqual(['number-substitution']); expect(quality.insufficientTemplates).toEqual(['other', 'support']);
  });
  it('passes exactly 95% accuracy but stops missing finals even at the 5% instability boundary', () => {
    const traps = [...Array.from({ length: 19 }, () => correct), { ...correct, actual: 'yes' }];
    const checks = [...Array.from({ length: 19 }, () => check(['yes', 'yes'])), check(['yes', 'no'])];
    expect(referenceQuality([output(checks.slice(0, 19))], [...traps, control], population).gate).toBe('PASS');
    const missing = referenceQuality([output(checks)], [...traps, control], population);
    expect(missing.gate).toBe('STOP');
    expect(missing.failures).toEqual(['missing base checks must be <= 0%']);
    expect(missing.instability.rate).toBe(0.05);
    expect(referenceQuality([output(checks.slice(1))], [...traps, control], population).gate).toBe('STOP');
    expect(referenceQuality([output(checks)], [...traps.slice(1), control], population).gate).toBe('STOP');
  });
  it('measures unchanged controls only against present baseline answers', () => {
    const controls: TrapAssessment[] = ['yes', null, undefined].map(baseline => ({ kind: 'option-permutation', templateId: 'support',
      intended: 'unchanged', actual: 'yes', ...(baseline === undefined ? {} : { baseline }) }));
    const quality = referenceQuality([], controls);
    expect(quality.optionPermutation).toEqual({ total: 3, correct: 1, accuracy: 1 / 3 });
    expect(quality.consistencyByKind['option-permutation']!.accuracy).toBe(1 / 3);
  });
  it('cannot certify accuracy with identical wrong control answers or certify consistency with defects alone', () => {
    const controlsOnly = referenceQuality([output([check()])], [control], population);
    expect(controlsOnly).toMatchObject({ gate: 'STOP', knownAnswer: { total: 0, accuracy: null }, consistency: { accuracy: 1 } });
    expect(controlsOnly.coverage.uncovered).toEqual(['output']);
    expect(referenceQuality([], [correct], population)).toMatchObject({ gate: 'STOP', consistency: { accuracy: null } });
    expect(referenceQuality([], [correct, { ...control, actual: 'yes' }], population).gate).toBe('STOP');
    const disguised = referenceQuality([], [{ ...control, intended: 'no' }, { ...correct, intended: 'unchanged' }], population);
    expect(disguised).toMatchObject({ gate: 'STOP', knownAnswer: { total: 0 }, consistency: { total: 0 } });
  });
  it('freezes coverage from all declared outputs and requires zero uncovered', () => {
    const outputIds = Array.from({ length: 10 }, (_, i) => `output-${i}`);
    const known = outputIds.slice(1).map(outputId => ({ ...correct, outputId }));
    const result = referenceQuality([], [...known, control], { outputIds });
    expect(result).toMatchObject({ gate: 'STOP', coverage: { total: 10, covered: 9, uncovered: ['output-0'], uncoveredRate: 0.1 } });
    expect(referenceQuality([], [...known.slice(1), control], { outputIds }).gate).toBe('STOP');
    expect(referenceQuality([], [...known, control]).gate).toBe('STOP');
    expect(referenceQuality([], [correct, control], { outputIds: ['different'] }).coverage.uncovered).toEqual(['different']);
  });
  it('uses only unique base checks for instability and reports variant adjudication separately', () => {
    const base = output([check(['yes', 'no'])]);
    const variants = Array.from({ length: 20 }, (_, i) => ({ ...output([check(['yes', 'yes'])]), outputDigest: `variant-${i}` }));
    const result = referenceQuality([base], [correct, control], { ...population, variantOutputs: variants });
    expect(result).toMatchObject({ gate: 'STOP', instability: { items: 1, unstable: 1, rate: 1 },
      variantAdjudication: { items: 1, unstable: 0, rate: 0 } });
    expect(adjudicationInstability([base, base])).toEqual({ items: 1, unstable: 1, rate: 1 });
    const stableCopy = output([check(['yes', 'yes'])]);
    expect(adjudicationInstability([base, stableCopy])).toEqual({ items: 1, unstable: 1, rate: 1 });
    expect(adjudicationInstability([stableCopy, base])).toEqual({ items: 1, unstable: 1, rate: 1 });
    expect(adjudicationInstability([output([check()]), stableCopy])).toEqual({ items: 1, unstable: 0, rate: 0 });
  });
  it('scores teachers against references excluding themselves, including missing peer mass', () => {
    const disagreement = check();
    const allYes = check(); allYes.teachers.b = { answer: 'yes' };
    const missing = check(); missing.teachers.b = { answer: null, status: 'missing' };
    const results = leaveOneTeacherOut([output([disagreement, allYes, missing])]);
    expect(results.a).toEqual({ items: 3, agreement: 1 / 3, softAgreement: 1 / 3 });
    expect(results.b).toEqual({ items: 3, agreement: 1 / 3, softAgreement: 1 / 3 });
    const only = check(); only.teachers = { a: { answer: 'yes' } };
    expect(leaveOneTeacherOut([output([only])])).toEqual({});
  });
});

it('stops constant defect labels even with perfect control consistency', () => {
  const result = referenceQuality([], [{ ...correct, baseline: 'no' }, control], population);
  expect(result).toMatchObject({ gate: 'STOP', knownAnswer: { correct: 0 }, consistency: { accuracy: 1 } });
});
it('gates kinds and templates with at least ten traps even when pooled accuracy passes', () => {
  const many = Array.from({ length: 200 }, () => correct);
  const bad = Array.from({ length: 10 }, () => ({ ...correct, kind: 'entity-substitution', templateId: 'entity', actual: 'yes' }));
  const result = referenceQuality([], [...many, ...bad, control], population);
  expect(result.knownAnswer.accuracy).toBeGreaterThan(0.95);
  expect(result.gate).toBe('STOP');
  expect(result.failures).toContain('known-answer kind entity-substitution accuracy must be >= 0.95');
  expect(result.failures).toContain('known-answer template entity accuracy must be >= 0.95');
  const insufficient = referenceQuality([], [...many, ...bad.slice(1), control], population);
  expect(insufficient.gate).toBe('PASS');
  expect(insufficient.insufficientKinds).toEqual(['entity-substitution']);
  expect(insufficient.insufficientTemplates).toEqual(['entity']);
});
it('counts rejected units as missing coverage, excludes unready checks and preserves uncertain copies', () => {
  expect(referenceQuality([], [correct, control], { ...population, rejectedUnits: 1 }))
    .toMatchObject({ gate: 'STOP', coverage: { missingChecks: 1 } });
  const uncertain = { ...check(), status: 'uncertain' as const, final: null };
  expect(adjudicationInstability([output([uncertain]), output([check()])])).toMatchObject({ items: 1, unstable: 1 });
  expect(adjudicationInstability([output([{ ...uncertain, ready: false }, check()])])).toMatchObject({ items: 1, unstable: 0 });
});

it('treats an uncertain final as unstable even when both adjudication labels match', () => {
  const unresolved = { ...check(['yes', 'yes']), status: 'uncertain' as const };
  expect(adjudicationInstability([output([unresolved])])).toEqual({ items: 1, unstable: 1, rate: 1 });
});

it.each([
  { ready: false, final: null },
  { ready: true, final: null },
  { ready: false, final: 'yes' },
])('stops every missing base check independently of traps and instability: %j', missing => {
  const checks = [...Array.from({ length: 20 }, () => check()), { ...check(), ...missing, template_id: 'actor' }];
  const result = referenceQuality([output(checks)], [correct, control], population);
  expect(result.gate).toBe('STOP');
  expect(result.failures).toContain('missing base checks must be <= 0%');
  expect(result.completeness).toEqual({ total: 21, missing: 1, rate: 1 / 21,
    byTemplate: { support: { total: 20, missing: 0, rate: 0 }, actor: { total: 1, missing: 1, rate: 1 } },
    byOutput: { output: { total: 21, missing: 1, rate: 1 / 21 } } });
  expect(result.coverage.missingChecks).toBe(0);
});
it('counts a duplicate missing base check once, preserves missing copies and ignores variants', () => {
  const base = output([{ ...check(), ready: false, final: null }]);
  for (const outputs of [[base, output([check()])], [output([check()]), base], [base, base]]) {
    expect(referenceQuality(outputs, [correct, control], { variantOutputs: [output([check()])], outputIds: [] }).completeness)
      .toMatchObject({ total: 1, missing: 1, rate: 1, byOutput: { output: { total: 1, missing: 1 } } });
  }
});
