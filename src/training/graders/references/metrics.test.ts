import { describe, expect, it } from 'vitest';
import { adjudicationInstability, leaveOneTeacherOut, referenceQuality } from './metrics.js';
import type { CheckReference, CouncilOutput, TrapAssessment } from './types.js';

function check(adjudication: string[] = []): CheckReference {
  return { digest: 'x', template_id: 'support', teachers: { a: { answer: 'yes' }, b: { answer: 'no' } },
    distribution: { yes: 0.5, no: 0.5 }, unknown_mass: 0, adjudication: adjudication.map(answer => ({ answer })), final: null, status: 'uncertain' };
}
function output(checks: CheckReference[]): CouncilOutput {
  return { outputDigest: 'output', identity: 'identity', digest: 'digest', complete: true,
    checks: Object.fromEntries(checks.map((value, index) => [index, value])), calls: [], skipped: [] };
}
const correct: TrapAssessment = { kind: 'number-substitution', templateId: 'support', intended: 'no', actual: 'no' };
describe('council quality gate', () => {
  it('counts uncertain as an answer and uses adjudicated items, not all items, as the instability denominator', () => {
    const outputs = [output([check(), check(['yes', 'yes']), check(['yes', 'no']), check(['uncertain', 'uncertain']), check(['uncertain', 'yes'])])];
    expect(adjudicationInstability(outputs)).toEqual({ items: 4, unstable: 2, rate: 0.5 });
    expect(adjudicationInstability([output([check(['yes'])])])).toEqual({ items: 1, unstable: 1, rate: 1 });
    expect(adjudicationInstability([])).toEqual({ items: 0, unstable: 0, rate: 0 });
  });
  it('fails closed without traps and counts missing/uncertain against every intended instance', () => {
    expect(referenceQuality([], []).gate).toBe('STOP');
    const quality = referenceQuality([], [correct, { ...correct, actual: null }, { ...correct, templateId: 'other', actual: 'uncertain' }]);
    expect(quality.overall).toEqual({ total: 3, correct: 1, accuracy: 1 / 3 });
    expect(quality.failingKinds).toEqual(['number-substitution']); expect(quality.failingTemplates).toEqual(['other', 'support']);
  });
  it('passes exactly 95% accuracy and 5% instability and stops just outside the boundary', () => {
    const traps = [...Array.from({ length: 19 }, () => correct), { ...correct, actual: 'yes' }];
    const checks = [...Array.from({ length: 19 }, () => check(['yes', 'yes'])), check(['yes', 'no'])];
    expect(referenceQuality([output(checks)], traps).gate).toBe('PASS');
    expect(referenceQuality([output(checks.slice(1))], traps).gate).toBe('STOP');
    expect(referenceQuality([output(checks)], traps.slice(1)).gate).toBe('STOP');
  });
  it('measures unchanged controls only against present baseline answers', () => {
    const controls: TrapAssessment[] = ['yes', null, undefined].map(baseline => ({ kind: 'option-permutation', templateId: 'support',
      intended: 'unchanged', actual: 'yes', ...(baseline === undefined ? {} : { baseline }) }));
    const quality = referenceQuality([], controls);
    expect(quality.optionPermutation).toEqual({ total: 3, correct: 1, accuracy: 1 / 3 });
    expect(quality.byKind['option-permutation']!.accuracy).toBe(1 / 3);
  });
  it('scores teachers against references excluding themselves, including missing peer mass', () => {
    const disagreement = check();
    const allYes = check(); allYes.teachers.b = { answer: 'yes' };
    const missing = check(); missing.teachers.b = { answer: 'missing' };
    const results = leaveOneTeacherOut([output([disagreement, allYes, missing])]);
    expect(results.a).toEqual({ items: 3, agreement: 1 / 3, softAgreement: 1 / 3 });
    expect(results.b).toEqual({ items: 3, agreement: 1 / 3, softAgreement: 1 / 3 });
    const only = check(); only.teachers = { a: { answer: 'yes' } };
    expect(leaveOneTeacherOut([output([only])])).toEqual({});
  });
});
