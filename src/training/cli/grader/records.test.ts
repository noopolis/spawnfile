import { describe, expect, it } from 'vitest';
import { parseGrader, type Label, type Labels } from '../../graders/index.js';
import type { DecisionResult } from '../../contracts/grading.js';
import { goldenInstances, independentConsensus, rawGood, calibrationRecord, cascadeRecord } from './records.js';

function grader(teacher = false) {
  return parseGrader({ schema: 'paideia.grader.v1', id: 'g', golden: 'l', calibration: 'c',
    teachers: [{ id: 'a', provider: 'claude', model: 'm' }],
    model: teacher ? { backend: 'teacher', teacher: 'a' } : { backend: 'ollama-logprobs', endpoint: 'http://localhost:11434', name: 'm' },
    escalate: { to: 'a', between: [0.4, 0.6] }, score: { method: 'weighted' },
    questions: [{ id: 'q', ask: 'Good?', type: 'yes-no', expected: 'yes', reads: ['output.body'] },
      { id: 'missing', type: 'yes-no', expected: 'yes', reads: ['output.absent'] },
      { id: 'inactive', type: 'yes-no', expected: 'yes', reads: [], when: { field: 'output.active', equals: true } },
      { id: 'choice', type: 'choice', options: ['a', 'b', 'c'], expected: ['a', 'b'], reads: ['output.body'] }],
  });
}
function label(): Label {
  return { id: 'output', lineage: 'lineage', example: { dataset: 'train', id: 'ex' },
    output: { body: ['Article'], active: false }, context: {}, asked: ['a', 'b'],
    votes: { q: { a: 'yes', b: 'no', human: 'yes' }, choice: { a: 'a', b: 'a' } }, provenance: {} };
}
function labels(): Labels {
  return { schema: 'paideia.labels.v1', grader: 'g', labels: [label()], labelers: {
    a: { kind: 'model', provider: 'claude', model: 'm' }, b: { kind: 'model', provider: 'grok', model: 'm' },
    human: { kind: 'human', name: 'H' },
  } };
}

describe('calibration record preparation', () => {
  it('builds projected requests, skips false applicability, and counts missing and disputes separately', () => {
    const input = labels();
    const result = goldenInstances(grader(), input);
    expect(result).toMatchObject({ unavailable: 1, disputed: 0 });
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]!.request).toEqual({ key: 'output:q', type: 'yes-no', optionLabels: ['yes', 'no'],
      expectedOptions: ['yes'], instructions: 'Good?', projection: { 'output.body': ['Article'] } });
    expect(result.rows[1]!.request.instructions).toBe('choice');
    input.labels[0]!.votes.q = { a: 'yes', b: 'no' };
    expect(goldenInstances(grader(), input)).toMatchObject({ unavailable: 1, disputed: 1 });
    expect(goldenInstances(grader(), { ...input, labels: [] })).toEqual({ rows: [], unavailable: 0, disputed: 0 });
  });
  it('excludes the decision teacher before deriving golden, preserving human and asked missing votes', () => {
    const input = labels();
    input.labels[0]!.votes.q = { a: 'yes', b: 'no' };
    expect(goldenInstances(grader(true), input).rows[0]!.golden.answer).toBe('no');
    input.labels[0]!.votes.q.human = 'yes';
    expect(independentConsensus(input.labels[0]!, input.labelers, 'a', ['q']).q!.answer).toBe('yes');
    input.labels[0]!.asked = ['a', 'b', 'missing'];
    input.labels[0]!.votes.q = { a: 'yes', b: 'no' };
    input.labelers.missing = { kind: 'model', provider: 'grok', model: 'm' };
    expect(independentConsensus(input.labels[0]!, input.labelers, 'a', ['q']).q!.disputed).toBe(true);
    input.labels[0]!.asked = undefined;
    expect(independentConsensus(input.labels[0]!, input.labelers, 'a', ['q']).q!.answer).toBe('no');
  });
  it('sums expected option mass and refuses incomplete, nonfinite, out-of-range or unnormalized probabilities', () => {
    const row = goldenInstances(grader(), labels()).rows[1]!;
    const ok: DecisionResult = { key: row.request.key, status: 'ok', probabilities: { a: 0.2, b: 0.3, c: 0.5 } };
    expect(rawGood(row, ok)).toBe(0.5);
    expect(rawGood(row, { ...ok, status: 'missing' })).toBeUndefined();
    expect(rawGood(row, { ...ok, probabilities: null })).toBeUndefined();
    for (const probabilities of [{ a: 0.5, b: 0.5 }, { a: NaN, b: 0, c: 1 }, { a: -0.1, b: 0.1, c: 1 },
      { a: 1.1, b: 0, c: 0 }, { a: 0.2, b: 0.2, c: 0.2 }] as Record<string, number>[]) {
      expect(() => rawGood(row, { ...ok, probabilities })).toThrow('invalid option probabilities');
    }
  });
  it('retains source and lineage while supplying the full asked denominator and per-output call identity', () => {
    const input = labels(), row = goldenInstances(grader(), input).rows[0]!;
    const record = calibrationRecord(row, 0.8);
    expect(record).toEqual({ questionId: 'q', type: 'yes-no', group: 'lineage', example: { dataset: 'train', id: 'ex' },
      source: 'human', rawPGood: 0.8, good: true });
    row.label.asked = undefined;
    row.label.votes.choice!.other = 'a';
    expect(cascadeRecord(row, record, 0.7, input.labelers)).toMatchObject({ p: 0.7, outputId: 'output',
      projectionDigest: row.instance.projectionDigest, expected: ['yes'], asked: ['a', 'b', 'human', 'other'],
      votes: { a: 'yes', b: 'no', human: 'yes' }, goldenLabelers: ['a', 'b', 'human'] });
    row.label.asked = ['asked-but-missing'];
    delete row.label.votes.q;
    expect(cascadeRecord(row, record, 0.7, input.labelers)).toMatchObject({ votes: {}, asked: ['asked-but-missing', 'a', 'b', 'other'] });
    expect(calibrationRecord({ ...row, golden: { ...row.golden, answer: 'no' } }, 0.2).good).toBe(false);
  });
});
