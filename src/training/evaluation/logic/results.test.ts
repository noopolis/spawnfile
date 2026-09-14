import { describe, expect, it } from 'vitest';
import { result, negate, combine, weightedScore, checkThreshold } from './index.js';
import type { Verdict } from '../../contracts/evaluation.js';

describe('logical and scoring semantics', () => {
  it('preserves uncertainty under negation and preserves diagnostics under decisive witnesses', () => {
    const statuses: Verdict[] = ['pass', 'fail', 'unknown', 'error', 'skipped'];
    for (const status of statuses) {
      expect(negate(result(status, 'evidence')).status).toBe(status === 'pass' ? 'fail' : status === 'fail' ? 'pass' : status);
    }
    expect(negate({ ...result('pass', 'graded'), score: 0.8 }).score).toBeCloseTo(0.2);
    const mixed = combine('all', [result('fail', 'violation'), result('unknown', 'partial')]);
    expect(mixed.status).toBe('fail');
    expect(mixed.children).toHaveLength(2);
    expect(combine('any', [result('pass', 'witness'), result('error', 'provider')]).status).toBe('pass');
    for (const status of ['unknown', 'error', 'skipped'] as const) {
      expect(combine('all', [result('pass', 'ok'), result(status, 'missing')]).status).toBe(status);
      expect(combine('any', [result('fail', 'no'), result(status, 'missing')]).status).toBe(status);
    }
    expect(combine('any', [result('fail', 'a'), result('fail', 'b')]).status).toBe('fail');
    expect(combine('all', [result('pass', 'a'), result('pass', 'b')]).status).toBe('pass');
    expect(() => combine('all', [])).toThrow('empty');
  });
  it('separates provisional failure from an irreversible failure witness', () => {
    expect(combine('all', [result('fail', 'repairable', false), result('pass', 'ok')]).finality).toBe('provisional');
    expect(combine('all', [result('fail', 'forbidden'), result('pass', 'unfinished', false)]).finality).toBe('final');
    expect(combine('any', [result('fail', 'not yet', false), result('fail', 'closed')]).finality).toBe('provisional');
  });
  it('never renormalizes surviving grades and rejects invalid weighting or measurements', () => {
    const score = weightedScore({ observed: 0.6, missing: 0.4 }, { observed: result('pass', 'yes') });
    expect(score).toEqual({ lower: 0.6, upper: 1, assessedWeight: 0.6, missingWeight: 0.4, finality: 'provisional' });
    expect(checkThreshold(score, 0.5).status).toBe('unknown');
    expect(checkThreshold(undefined, 0.5).status).toBe('unknown');
    for (const weights of [{}, { x: -1, y: 2 }, { x: NaN }, { x: 0 }] as Record<string, number>[]) {
      expect(() => weightedScore(weights, {})).toThrow('weights');
    }
    const checks = { good: { ...result('pass', 'good'), score: 0.8 }, bad: result('fail', 'bad'), missing: result('unknown', 'missing') };
    const complete = weightedScore({ good: 0.5, bad: 0.5 }, checks);
    expect(checkThreshold(complete, 0.4).status).toBe('pass');
    expect(checkThreshold(complete, 0.5).status).toBe('fail');
    expect(weightedScore({ missing: 1 }, checks).missingWeight).toBe(1);
    for (const value of [NaN, -0.1, 1.1]) {
      expect(() => weightedScore({ bad: 1 }, { bad: { ...checks.bad, score: value } })).toThrow('score');
      expect(() => checkThreshold(complete, value)).toThrow('threshold');
    }
  });
});

it('normalizes relative weights once against every declared criterion', () => {
  const checks = { first: { ...result('pass', 'graded'), score: 0.9 }, second: { ...result('fail', 'graded'), score: 0.3 } };
  expect(weightedScore({first:2,second:1}, checks).lower).toBeCloseTo(0.7);
  const partial = weightedScore({first:2,second:1}, {first:checks.first});
  expect(partial.lower).toBeCloseTo(0.6);
  expect(partial.missingWeight).toBeCloseTo(1/3);
  expect(checkThreshold(partial,0.5).status).toBe('unknown');
  expect(() => weightedScore({first:Number.MAX_VALUE,second:Number.MAX_VALUE},checks)).toThrow('positive total');
});
