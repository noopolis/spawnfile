import { describe, expect, it } from 'vitest';
import { applyPlatt, calibrateQuestions, fitPlatt, splitCalibration } from './index.js';
import type { CalibrationRecord } from './index.js';

function records(groups: number): CalibrationRecord[] {
  return Array.from({ length: groups }, (_, index) => ({ questionId: 'quality', type: 'yes-no',
    group: `g${index}`, good: index % 2 === 0, rawPGood: index % 2 === 0 ? 0.99 : 0.01, source: 'consensus' }));
}

describe('group split and exclusions', () => {
  it('never splits a lineage and is deterministic independent of input order', () => {
    const rows = records(41).flatMap(row => [row, { ...row }]);
    const result = splitCalibration(rows, 'seed');
    const fit = new Set(result.fit.map(row => row.group));
    expect(fit.size).toBe(20);
    expect(result.heldOut.every(row => !fit.has(row.group))).toBe(true);
    expect(new Set(splitCalibration([...rows].reverse(), 'seed').fit.map(row => row.group))).toEqual(fit);
    expect(new Set(splitCalibration(rows, 'different').fit.map(row => row.group))).not.toEqual(fit);
  });
  it('excludes complete lineages and examples before either split', () => {
    const rows = records(10);
    rows[1]!.example = { dataset: 'sealed', id: 'case' };
    rows.push({ ...rows[1]!, example: undefined });
    const result = splitCalibration(rows, 'seed', {
      lineages: ['g0'], examples: [{ dataset: 'sealed', id: 'case' }],
    });
    expect(result.excluded.map(row => row.group)).toEqual(['g0', 'g1', 'g1']);
    expect([...result.fit, ...result.heldOut].every(row => !['g0', 'g1'].includes(row.group))).toBe(true);
    expect(splitCalibration(rows, 'seed', { examples: [{ dataset: 'other', id: 'case' }] }).excluded).toEqual([]);
  });
});

describe('regularized Platt fit', () => {
  it('recovers known identity parameters on synthetic binary frequency data', () => {
    const rows = Array.from({ length: 9 }, (_, index) => (index + 1) / 10).flatMap(p =>
      Array.from({ length: 100 }, (_, index) => ({ rawPGood: p, good: index < Math.round(p * 100) })));
    const fitted = fitPlatt(rows);
    expect(fitted.converged).toBe(true);
    expect(fitted.a).toBeCloseTo(1, 6);
    expect(fitted.b).toBeCloseTo(0, 6);
  });
  it('recovers known nonidentity optimum of the specified penalized objective', () => {
    // For balanced x=-1,+1, these binary frequencies make the regularized
    // gradient zero at (a,b)=(0.9,0.05), rather than assuming MLE consistency.
    const a = 0.9, b = 0.05, size = 20_000;
    const sample = [-1, 1].flatMap(x => {
      const frequency = 1 / (1 + Math.exp(-(a * x + b))) + 0.02 * ((a - 1) * x + b);
      return Array.from({ length: size }, (_, index) => ({ rawPGood: 1 / (1 + Math.exp(-x)),
        good: index < Math.round(size * frequency) }));
    });
    const fitted = fitPlatt(sample);
    expect(fitted.converged).toBe(true);
    expect(fitted.a).toBeCloseTo(a, 3);
    expect(fitted.b).toBeCloseTo(b, 3);
  });
  it('recovers generating parameters on synthetic data within regularization tolerance', () => {
    const a = 1.4, b = -0.4, size = 10_000;
    const sample = [-3, -2, -1, 0, 1, 2, 3].flatMap(x => {
      const frequency = 1 / (1 + Math.exp(-(a * x + b)));
      return Array.from({ length: size }, (_, index) => ({ rawPGood: 1 / (1 + Math.exp(-x)),
        good: index < Math.round(size * frequency) }));
    });
    const fitted = fitPlatt(sample);
    expect(fitted.converged).toBe(true);
    expect(Math.abs(fitted.a - a)).toBeLessThan(0.10);
    expect(Math.abs(fitted.b - b)).toBeLessThan(0.10);
  });
  it('learns a nontrivial correction, stays regularized and clips extremes', () => {
    const fitted = fitPlatt(Array.from({ length: 50 }, () => ({ rawPGood: 0.9, good: false })));
    expect(fitted.converged).toBe(true);
    expect(fitted.a).toBeLessThan(1);
    expect(applyPlatt(0.9, fitted)).toBeLessThan(0.1);
    expect(fitted.b).toBeLessThan(0);
    expect(applyPlatt(0, { a: 1, b: 0 })).toBeCloseTo(1e-6, 10);
    expect(applyPlatt(1, { a: 1, b: 0 })).toBeCloseTo(1 - 1e-6, 10);
    expect(fitPlatt([], {})).toMatchObject({ converged: false, iterations: 0 });
    expect(fitPlatt([{ rawPGood: 0.9, good: false }], { maxIterations: 1 }).converged).toBe(false);
    for (const p of [NaN, -0.1, 1.1, Infinity]) expect(() => applyPlatt(p, { a: 1, b: 0 })).toThrow('rawPGood');
    expect(() => applyPlatt(0.5, { a: NaN, b: 0 })).toThrow('params');
    expect(() => fitPlatt([], { maxIterations: 0 })).toThrow('fit options');
    expect(() => fitPlatt([], { tolerance: 0 })).toThrow('fit options');
  });
});

describe('question and pooled fitting', () => {
  it('uses pooled fit at 19 fit groups and per-question at exactly 20', () => {
    expect(calibrateQuestions(records(38), { seed: 's' })[0]).toMatchObject({ fitGroups: 19, fitSource: 'type' });
    expect(calibrateQuestions(records(40), { seed: 's' })[0]).toMatchObject({ fitGroups: 20, fitSource: 'question' });
  });
  it('refuses a question with no fit instances even if its type pool can fit', () => {
    const original = records(40);
    const held = splitCalibration(original, 's').heldOut;
    const sparse = held.flatMap(row => [{ ...row, questionId: 'sparse' }, { ...row, questionId: 'sparse' }]);
    const result = calibrateQuestions([...sparse, ...original], { seed: 's' })[0]!;
    expect(result).toMatchObject({ status: 'insufficient-evidence', fitGroups: 0,
      failures: expect.arrayContaining(['fit.questionInstances > 0']), metrics: { baseRate: 0 } });
  });
  it('splits the full golden universe and excludes missing decisions only from fitting', () => {
    const original = records(100), split = splitCalibration(original, 'missing');
    split.fit.slice(0, 5).forEach(row => { row.missing = true; row.rawPGood = NaN; });
    split.heldOut.slice(0, 10).forEach(row => { row.missing = true; row.rawPGood = NaN; });
    const result = calibrateQuestions(original, { seed: 'missing' })[0]!;
    const fit = fitPlatt(split.fit.filter(row => !row.missing));
    expect(result.fitGroups).toBe(45);
    expect(result.params).toEqual({ a: fit.a, b: fit.b });
    expect(result.metrics).toMatchObject({ groups: 50, instances: 50, accuracy: 0.8 });
    expect(result.metrics.brier).toBeGreaterThanOrEqual(0.2);
    expect(result.metrics.ece).toBeGreaterThanOrEqual(0.2);
    expect(result.status).toBe('uncalibrated');
    split.fit.forEach(row => { row.missing = true; });
    expect(calibrateQuestions(original, { seed: 'missing' })[0]).toMatchObject({ fitGroups: 0,
      status: 'insufficient-evidence', failures: expect.arrayContaining(['fit.questionInstances > 0']) });
  });
  it('pools only the matching type, exposes source metrics and gate false passes', () => {
    const rows = records(40);
    const split = splitCalibration(rows, 's');
    split.heldOut[0]!.source = 'human';
    split.heldOut[1]!.source = 'single-teacher';
    const subset = rows.filter(row => row.group !== split.fit[0]!.group);
    const sibling = rows.map(row => ({ ...row, questionId: 'sibling', rawPGood: 0.9, good: false }));
    const unrelated = rows.map(row => ({ ...row, questionId: 'different', type: 'choice' as const, rawPGood: 0.1, good: true }));
    const result = calibrateQuestions([...subset, ...sibling, ...unrelated], { seed: 's', gates: ['quality'] })[0]!;
    expect(result.fitSource).toBe('type');
    expect(result.metrics.falsePassRate).toBeDefined();
    expect(Object.keys(result.bySource).sort()).toEqual(['consensus', 'human', 'single-teacher']);
    expect(result.interpretation).toBe('human-adjudicated and teacher agreement');
    const expectedFit = splitCalibration([...subset, ...sibling, ...unrelated], 's').fit.filter(row => row.type === 'yes-no');
    expect(result.params.a).toBeCloseTo(fitPlatt(expectedFit).a);
    const ownFit = expectedFit.filter(row => row.questionId === 'quality');
    expect(result.metrics.baseRate).toBe(ownFit.filter(row => row.good).length / ownFit.length);
    expect(calibrateQuestions(rows, { seed: 's', exclusions: { lineages: rows.map(row => row.group) } })[0])
      .toMatchObject({ status: 'insufficient-evidence', failures: expect.arrayContaining(['fit.convergence']) });
    expect(() => calibrateQuestions([rows[0]!, { ...rows[1]!, type: 'score' }], { seed: 's' })).toThrow('quality.type');
    expect(calibrateQuestions([], { seed: 's' })).toEqual([]);
  });
});

it('reports editor agreement separately from model consensus', () => {
  const rows = records(80).map(row => ({ ...row, source: 'editor' as const }));
  const result = calibrateQuestions(rows, { seed: 'editor' })[0]!;
  expect(result.interpretation).toBe('editor-adjudicated and teacher agreement');
  expect(result.bySource.editor).toMatchObject({ instances: 40 });
  expect(result.bySource.human).toBeUndefined();
});
