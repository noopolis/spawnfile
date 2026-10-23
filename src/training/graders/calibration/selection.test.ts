import { describe, expect, it } from 'vitest';
import { fitNll, fitPlatt, selectQuestionModel, splitCalibration } from './index.js';
import type { CalibrationRecord } from './index.js';

const identity = { a: 1, b: 0 };
function records(count = 40): CalibrationRecord[] {
  return Array.from({ length: count }, (_, index) => ({ questionId: 'q', type: 'yes-no',
    group: `g${index}`, good: index % 2 === 0, rawPGood: index % 2 === 0 ? 0.9 : 0.1, source: 'human' }));
}
function candidate(id: string, fit: CalibrationRecord[], teacher = false) { return { id, fit, teacher }; }

describe('per-question decision-model selection', () => {
  it('ranks calibrated probabilities rather than the raw probabilities', () => {
    const inverted = records().map(row => ({ ...row, rawPGood: 1 - row.rawPGood }));
    const noisy = records().map((row, index) => ({ ...row,
      rawPGood: (index % 5 === 0 ? !row.good : row.good) ? 0.8 : 0.2 }));
    expect(fitNll(inverted, identity)).toBeGreaterThan(fitNll(noisy, identity));
    expect(fitNll(inverted, fitPlatt(inverted))).toBeLessThan(fitNll(noisy, fitPlatt(noisy)));
    expect(selectQuestionModel('q', 'yes-no', [candidate('raw-winner', noisy), candidate('calibrated-winner', inverted)]))
      .toBe('calibrated-winner');
    expect(selectQuestionModel('q', 'yes-no', [candidate('teacher', inverted, true), candidate('local', noisy)]))
      .toBe('local');
  });

  it('selects with fit rows when held-out rows prefer the other model', () => {
    const population = records(80);
    const fitGroups = new Set(splitCalibration(population, 'selection-only').fit.map(row => row.group));
    const first = population.map(row => ({ ...row,
      rawPGood: fitGroups.has(row.group) ? row.good ? 0.99 : 0.01 : 0.5 }));
    const second = population.map((row, index) => ({ ...row,
      rawPGood: (fitGroups.has(row.group) && index % 4 === 0 ? !row.good : row.good) ? 0.8 : 0.2 }));
    const a = splitCalibration(first, 'selection-only'), b = splitCalibration(second, 'selection-only');
    expect(fitNll(a.fit, fitPlatt(a.fit))).toBeLessThan(fitNll(b.fit, fitPlatt(b.fit)));
    expect(fitNll(a.heldOut, fitPlatt(a.fit))).toBeGreaterThan(fitNll(b.heldOut, fitPlatt(b.fit)));
    expect(selectQuestionModel('q', 'yes-no', [candidate('fit-winner', a.fit), candidate('held-out-winner', b.fit)]))
      .toBe('fit-winner');
    expect(selectQuestionModel('q', 'yes-no', [candidate('fit-winner', a.heldOut), candidate('held-out-winner', b.heldOut)]))
      .toBe('held-out-winner');
  });

  it.each([true, false])('charges a missing answer the same maximum loss for good=%s and retains its denominator', good => {
    const rows = [{ ...records(1)[0]!, good, rawPGood: good ? 0.9 : 0.1 },
      { ...records(1)[0]!, group: 'missing', good, rawPGood: NaN, missing: true }];
    expect(fitNll(rows, identity)).toBeCloseTo((-Math.log(0.9) - Math.log(1e-6)) / 2, 10);
  });

  it('prevents a model from winning by abstaining on the difficult half of its golden fit rows', () => {
    const complete = records().map(row => ({ ...row, rawPGood: 0.5 }));
    const abstaining = records().map((row, index) => ({ ...row, rawPGood: row.good ? 0.999 : 0.001,
      ...(index % 4 < 2 ? { missing: true } : {}) }));
    const answered = abstaining.filter(row => !row.missing);
    expect(fitNll(answered, fitPlatt(answered))).toBeLessThan(fitNll(complete, fitPlatt(complete)));
    expect(selectQuestionModel('q', 'yes-no', [candidate('abstaining', abstaining), candidate('complete', complete)]))
      .toBe('complete');
  });

  it('preserves authored order for exact ties and no fit evidence', () => {
    const rows = records();
    expect(selectQuestionModel('q', 'yes-no', [candidate('z', rows), candidate('a', rows)])).toBe('z');
    expect(selectQuestionModel('q', 'yes-no', [candidate('a', rows), candidate('z', rows)])).toBe('a');
    expect(selectQuestionModel('absent', 'yes-no', [candidate('z', rows), candidate('a', rows)])).toBe('z');
    expect(selectQuestionModel('q', 'yes-no', [candidate('z', []), candidate('a', [])])).toBe('z');
    expect(fitNll([], identity)).toBe(Infinity);
    expect(() => selectQuestionModel('q', 'yes-no', [])).toThrow('requires candidates');
  });

  it('uses the same type-pooled fitting as calibration for sparse questions', () => {
    const ownA = [{ ...records(1)[0]!, rawPGood: 0.99 }];
    const ownB = [{ ...records(1)[0]!, rawPGood: 0.6 }];
    const poolA = records(40).map(row => ({ ...row, questionId: 'sibling', rawPGood: 0.99, good: false }));
    const poolB = records(40).map(row => ({ ...row, questionId: 'sibling', rawPGood: 0.6, good: true }));
    expect(fitNll(ownA, fitPlatt(ownA))).toBeLessThan(fitNll(ownB, fitPlatt(ownB)));
    expect(selectQuestionModel('q', 'yes-no', [candidate('own-winner', [...ownA, ...poolA]),
      candidate('pooled-winner', [...ownB, ...poolB])])).toBe('pooled-winner');
    const unrelated = records(200).map(row => ({ ...row, questionId: 'different', type: 'choice' as const,
      good: false, rawPGood: 0.6 }));
    expect(selectQuestionModel('q', 'yes-no', [candidate('own-winner', [...ownA, ...poolA]),
      candidate('pooled-winner', [...ownB, ...poolB, ...unrelated])])).toBe('pooled-winner');
  });

  it('excludes disputed fit answers from selection', () => {
    const complete = records();
    const disputed = complete.map(row => ({ ...row, disputed: true, rawPGood: row.good ? 1 : 0 }));
    expect(selectQuestionModel('q', 'yes-no', [candidate('disputed', disputed), candidate('observed', complete)]))
      .toBe('observed');
  });
});
