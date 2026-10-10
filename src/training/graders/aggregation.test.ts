import { describe, expect, it } from 'vitest';
import { parseGrader } from './format/index.js';
import { expandInstances } from './instances.js';
import { aggregateGrader } from './aggregation.js';
import type { GateOutcome, InstanceOutcome } from './aggregation.js';

function grader(questions: unknown[], gates: unknown[] = [], passAt = 0.5) {
  return parseGrader({ schema: 'paideia.grader.v1', id: 'test', golden: 'golden.yaml', calibration: 'cal.json',
    teachers: [{ id: 't', provider: 'codex', model: 'model' }], model: { backend: 'teacher', teacher: 't' },
    escalate: { to: 't', between: [0.3, 0.7] }, gates,
    questions: questions.map(question => ({ id: 'q', type: 'yes-no', expected: 'yes', reads: [], ...question as object })),
    score: { method: 'weighted', pass_at: passAt } });
}

describe('grader aggregation', () => {
  it('keeps all declared weights when outcomes are missing', () => {
    const rubric = grader([{ id: 'a', weight: 1 }, { id: 'b', weight: 3 }]);
    const result = aggregateGrader(rubric, expandInstances(rubric, {}), { a: { pGood: 1 } });
    expect(result).toMatchObject({ status: 'unknown', score: 0.25, coverage: 0.5 });
    expect(result.questions[1]).toMatchObject({ score: 0, missing: 1 });
  });

  it('keeps all declared weights when every instance of a question is N/A', () => {
    const rubric = grader([{ id: 'a', weight: 1 },
      { id: 'b', weight: 3, when: { field: 'output.kind', equals: 'news' }, not_applicable: 0.2 }]);
    const result = aggregateGrader(rubric, expandInstances(rubric, { kind: 'poem' }), { a: { pGood: 1 } });
    expect(result).toMatchObject({ status: 'fail', score: 0.4, coverage: 1 });
    expect(result.questions[1]).toMatchObject({ score: 0.2, not_applicable: 1 });
  });

  it('missing units remain in a question denominator; known N/A units do not', () => {
    const rubric = grader([{ level: 'paragraph' }]);
    const result = aggregateGrader(rubric, expandInstances(rubric, { body: ['A', 'B', 'C'] }), {
      'q@p0': { pGood: 1, escalated: true }, 'q@p1': { status: 'not-applicable' }, 'q@p2': { status: 'missing' },
    });
    expect(result.score).toBe(0.5);
    expect(result.coverage).toBeCloseTo(2 / 3);
    expect(result.questions[0]).toMatchObject({ instances: 3, escalated: 1, missing: 1, not_applicable: 1 });
  });

  it('gate failure zeros even perfect question scores and dominates unknown', () => {
    const rubric = grader([{}], [{ id: 'g', check: { eval: 'project-check' } }, { id: 'h', check: { eval: 'other' } }]);
    const result = aggregateGrader(rubric, expandInstances(rubric, {}), { q: { pGood: 1 } }, { g: 'fail', h: 'unknown' });
    expect(result).toMatchObject({ status: 'fail', score: 0 });
  });

  it.each(['unknown', 'error', undefined])('a %s gate cannot pass', status => {
    const rubric = grader([{}], [{ id: 'g', check: { eval: 'project-check' } }]);
    const result = aggregateGrader(rubric, expandInstances(rubric, {}), { q: { pGood: 1 } },
      status ? { g: status as GateOutcome } : {});
    expect(result).toMatchObject({ status: 'unknown', score: 1 });
  });

  it('passing mechanical gates allow a complete result to pass', () => {
    const rubric = grader([{}], [{ id: 'g', check: {} }]);
    expect(aggregateGrader(rubric, expandInstances(rubric, {}), { q: { pGood: 0.5 } }, { g: 'pass' }).status).toBe('pass');
  });

  it.each([[0.499, 'fail'], [0.5, 'pass'], [1, 'pass'], [undefined, 'unknown']] as const)('gate questions use the inclusive 0.5 boundary: %s', (pGood, status) => {
    const rubric = grader([{}], [{ id: 'g', type: 'yes-no', expected: 'no', reads: [] }]);
    const outcomes: Record<string, InstanceOutcome> = { q: { pGood: 1 } };
    if (pGood !== undefined) outcomes.g = { pGood };
    expect(aggregateGrader(rubric, expandInstances(rubric, {}), outcomes).status).toBe(status);
  });

  it('zero paragraphs stay missing even with fabricated probability or N/A outcomes', () => {
    const rubric = grader([{ level: 'paragraph', not_applicable: 1 }]);
    const instances = expandInstances(rubric, { body: [] });
    for (const outcome of [{ pGood: 1 }, { status: 'not-applicable' as const }]) {
      expect(aggregateGrader(rubric, instances, { q: outcome }))
        .toMatchObject({ score: 0, coverage: 0, status: 'unknown' });
    }
    expect(aggregateGrader(rubric, [], {})).toMatchObject({ score: 0, coverage: 0, status: 'unknown' });
  });

  it('natural-language applicability controls main scores and requires observed dependency', () => {
    const rubric = grader([{ when: 'A fact is claimed.', not_applicable: 0.3 }]);
    const instances = expandInstances(rubric, {});
    const aggregate = (outcomes: Record<string, InstanceOutcome>) => aggregateGrader(rubric, instances, outcomes);
    expect(aggregate({ q: { pGood: 1 } })).toMatchObject({ score: 0, coverage: 0, status: 'unknown' });
    expect(aggregate({ 'q.applies': { pGood: 0.49, escalated: true } }).questions[0])
      .toMatchObject({ score: 0.3, not_applicable: 1, escalated: 1 });
    expect(aggregate({ 'q.applies': { pGood: 0.5 }, q: { pGood: 0.9 } }).score).toBe(0.9);
    expect(aggregate({ 'q.applies': { status: 'not-applicable' }, q: { pGood: 1 } }).coverage).toBe(0);
    expect(aggregateGrader(rubric, instances.filter(instance => instance.key === 'q'),
      { 'q.applies': { pGood: 0 }, q: { pGood: 1 } }).coverage).toBe(0);
    const badDependency = instances.map(instance => instance.key === 'q.applies' ? { ...instance, state: 'missing' as const } : instance);
    expect(aggregateGrader(rubric, badDependency, { 'q.applies': { pGood: 0 }, q: { pGood: 1 } }).coverage).toBe(0);
  });

  it.each([NaN, Infinity, -0.1, 1.1])('invalid probability %s is missing, never an inflated score', pGood => {
    const rubric = grader([{}]);
    expect(aggregateGrader(rubric, expandInstances(rubric, {}), { q: { pGood } }))
      .toMatchObject({ score: 0, coverage: 0, status: 'unknown' });
  });

  it('missing zero-weight questions still lower coverage and keep status unknown', () => {
    const rubric = grader([{ id: 'a', weight: 1 }, { id: 'b', weight: 0 }]);
    expect(aggregateGrader(rubric, expandInstances(rubric, {}), { a: { pGood: 1 } }))
      .toMatchObject({ score: 1, coverage: 0.5, status: 'unknown' });
  });

  it('a complete score passes at the threshold and fails below it', () => {
    const rubric = grader([{}], [], 0.75);
    expect(aggregateGrader(rubric, expandInstances(rubric, {}), { q: { pGood: 0.75 } }).status).toBe('pass');
    expect(aggregateGrader(rubric, expandInstances(rubric, {}), { q: { pGood: 0.7499 } }).status).toBe('fail');
  });
});
