import { describe, expect, it } from 'vitest';
import { parseDatasetYaml, resolveDataset } from '../../cases/index.js';
import type { CheckNode, ResolvedDataset } from '../../contracts/dataset.js';
import { planTrainingCost, type TrainingCostOptions } from './planning.js';
import { resolveCostAssumptions } from './assumptions.js';

const rubric: CheckNode = { eval: 'llm-rubric', input: 'output.text', judge: 'prose', minimum: 0.8, rubric: { prompt: 'Clear prose.' } };
function dataset(name: string, groups: string[]): ResolvedDataset {
  return resolveDataset(parseDatasetYaml(JSON.stringify({ schema: 'paideia.dataset.v1', id: name,
    checks: [{ id: 'ok', eval: 'equals', input: 'output.text', value: 'OK' }],
    records: groups.map(group => ({ id: `${name}-${group}`, group, input: { prompt: 'Reply OK.' } })) })), { requireGroups: true });
}
function options(): TrainingCostOptions {
  return { train: dataset('development', ['a', 'b', 'c']), test: dataset('sealed', ['x', 'y']),
    subjectModel: 'gpt-5.5', optimizerModel: 'claude-fable-5-1',
    judges: { prose: { model: 'claude-fable-5-1', provider: 'claude-subscription' } }, maxTrials: 10, maxProposals: 2 };
}

describe('pure training cost plan', () => {
  it('reserves baseline and selected held-out trials and budgets reflection separately', () => {
    const plan = planTrainingCost(options());
    expect(plan).toMatchObject({ schema: 'paideia.training-cost-plan.v1', modelCallsMade: 0, coverage: 'estimated',
      budget: { maxTrials: 10, reservedTestTrials: 4, metricCalls: 6, maxProposals: 2 } });
    expect(plan.lines.map(line => [line.role, line.phase, line.plannedCalls])).toEqual([
      ['subject', 'development', 6], ['subject', 'held-out', 4], ['optimizer', 'optimization', 2],
    ]);
    expect(plan.apiEquivalentUsd?.low).toBeGreaterThan(0);
    expect(plan.apiEquivalentUsd?.high).toBeGreaterThan(plan.apiEquivalentUsd!.low);
    expect(plan.apiEquivalentUsd).toEqual(plan.pricedSubtotalUsd);
    expect(plan.datasetDigests.train).toBe(options().train.sourceDigest);
    expect(plan.warnings.some(warning => warning.includes('not a guaranteed'))).toBe(true);
  });
  it('counts all nested checks, turn checks, conditions and gates but never passed references', () => {
    const input = options();
    const record = input.train.records[0]!;
    record.effectiveStages = [{ id: 'stage', when: rubric,
      checks: [{ id: 'quality', all: [rubric, { not: { any: [rubric] } }] }], gate: { passed: 'quality' } }];
    record.turns = [{ id: 'turn', input: { prompt: 'Continue.' }, checks: [rubric] }];
    input.test.records[0]!.effectiveStages[0]!.gate = rubric;
    const perJudge = resolveCostAssumptions().judge;
    input.assumptions = { judges: { prose: perJudge } };
    const plan = planTrainingCost(input);
    const judges = plan.lines.filter(line => line.role === 'judge');
    expect(judges.map(line => [line.phase, line.plannedCalls])).toEqual([['development', 24], ['held-out', 2]]);
    expect(judges.every(line => line.model === 'claude-fable-5-1' && line.provider === 'claude-subscription')).toBe(true);
    expect(judges[0]!.tokensPerCall).toEqual(perJudge);
  });
  it('supports separate named judge models, explicit validation and defaults for judge tokens', () => {
    const input = options();
    input.train.subject = 'foreman';
    input.validation = dataset('validation', ['z']);
    input.validation.subject = 'foreman';
    input.test.subject = 'foreman';
    input.judges = { ...input.judges, grounding: { model: 'gpt-5.5', provider: 'custom-subscription' } };
    input.test.records[0]!.effectiveStages[0]!.checks = [rubric, { ...rubric, judge: 'grounding' }];
    const plan = planTrainingCost(input);
    expect(plan.datasetDigests.validation).toBe(input.validation.sourceDigest);
    expect(plan.lines[0]!.name).toBe('foreman');
    expect(plan.lines.filter(line => line.role === 'judge').map(line => line.model)).toEqual(['claude-fable-5-1', 'gpt-5.5']);
  });
  it('does not advertise finite complete estimates for live, embedding, or custom inference', () => {
    const input = options();
    input.train.records[0]!.live.checks = [{ ...rubric, id: 'live-quality', on: 'event' }];
    input.train.records[0]!.effectiveStages[0]!.checks.push({ eval: 'embedding-similarity' }, { eval: 'custom-paid-check' });
    const plan = planTrainingCost(input);
    expect(plan.coverage).toBe('partial');
    expect(plan.apiEquivalentUsd).toBeNull();
    expect(plan.pricedSubtotalUsd.high).toBeGreaterThan(0);
    expect(plan.warnings.filter(warning => /^(Unbounded|Unsupported)/.test(warning))).toHaveLength(3);
  });
  it('shows unpriced exact models rather than a zero total', () => {
    const plan = planTrainingCost({ ...options(), optimizerModel: 'new-unknown-model' });
    expect(plan.apiEquivalentUsd).toBeNull();
    expect(plan.lines.at(-1)!.apiEquivalentUsd).toBeNull();
    expect(plan.coverage).toBe('partial');
    expect(plan.warnings.some(warning => warning.includes('new-unknown-model'))).toBe(true);
  });
  it('rejects impossible budgets, leaked groups and unconfigured judges before execution', () => {
    for (const empty of ['train', 'validation', 'test'] as const) {
      const input = { ...options(), validation: dataset('validation', ['z']) };
      input[empty] = { ...input[empty], records: [] };
      expect(() => planTrainingCost(input)).toThrow('nonempty');
    }
    for (const budget of [0, 1.5, 10001]) expect(() => planTrainingCost({ ...options(), maxTrials: budget })).toThrow();
    expect(() => planTrainingCost({ ...options(), maxProposals: 1001 })).toThrow();
    expect(() => planTrainingCost({ ...options(), maxTrials: 4 })).toThrow('budget');
    expect(() => planTrainingCost({ ...options(), test: dataset('sealed', ['a']) })).toThrow();
    const input = options();
    input.train.records[0]!.effectiveStages[0]!.checks.push({ ...rubric, judge: 'missing' });
    expect(() => planTrainingCost(input)).toThrow('Missing judge');
  });
});
