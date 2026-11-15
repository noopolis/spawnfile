import { describe, expect, it, vi } from 'vitest';
import { parseDatasetYaml, resolveDataset } from '../cases/index.js';
import { testBankYaml, testJudge, testMaterial, testReplies } from '../questionnaire/index.js';
import { artifact, evaluationContext, snapshot } from '../testing/index.js';
import { createEvaluationRegistry, evaluatePlan } from './index.js';
import { evaluateQuestionnaire, questionnaireResources } from './questionnaire.js';

const check = { id: 'house-rules', eval: 'questionnaire', bank: 'bank.yaml', input: 'artifact:article',
  context: { evidence: 'context:evidence', assignment: 'context:assignment' } };
const context = (replies: readonly unknown[], overrides: Parameters<typeof snapshot>[0] = {}) => {
  const strong = testJudge(replies);
  return { strong, context: evaluationContext({ judges: { strong }, readText: async () => testBankYaml,
    snapshot: snapshot({ artifacts: { article: artifact(testMaterial.output) }, context: testMaterial.context, ...overrides }) }) };
};

describe('questionnaire check', () => {
  it('scores the whole bank, passes its gate and keeps every answer as evaluator evidence', async () => {
    const { context: evaluation } = context(testReplies);
    const observed = vi.fn();
    const result = await evaluateQuestionnaire(check, { ...evaluation, observeJudgeAttempt: observed });
    expect(result).toMatchObject({ status: 'pass', score: 0.6875, reason: 'Questionnaire test-bank: gate pass', finality: 'final' });
    expect(result.questionnaire).toMatchObject({ scoreOpen: 0.6667, scoreHidden: 0.75 });
    expect(result.judgeCalls).toHaveLength(2);
    expect(result.evidence.map(entry => entry.kind)).toEqual(['artifact', 'sidecar', 'sidecar', 'sidecar']);
    expect(observed).toHaveBeenCalledTimes(2);
    expect(questionnaireResources(evaluation)).toHaveLength(1);
  });
  it('fails on a failed gate question while still scoring', async () => {
    const { context: evaluation } = context([{ ...testReplies[0]!, figures: { answer: 'no', reason: 'P1 "seven"' } }, testReplies[1]]);
    expect(await evaluateQuestionnaire(check, evaluation)).toMatchObject({ status: 'fail', score: 0.4375, reason: 'Questionnaire test-bank: gate fail' });
  });
  it.each([
    [[{ ...testReplies[0]!, figures: { answer: 'true', reason: '' } }, testReplies[1]], 'response-schema', 'answers outside the declared type: figures'],
    [['not json', testReplies[1]], 'response-unparseable', 'judge reply was not a JSON object'],
    [[Object.assign(new Error('down'), { kind: 'unavailable' }), testReplies[1]], 'provider-error', 'judge call failed (unavailable)'],
  ])('is an error with a named cause, never a pass: %#', async (replies, cause, reason) => {
    const result = await evaluateQuestionnaire(check, context(replies).context);
    expect(result).toMatchObject({ status: 'error', judgeFailure: { cause, judge: 'strong' } });
    expect(result.reason).toContain(reason);
  });
  it('names an unusable route', async () => {
    const result = await evaluateQuestionnaire(check, { ...context([]).context, judges: {} });
    expect(result).toMatchObject({ status: 'error', judgeFailure: { cause: 'route-unusable', judge: 'strong', providerId: null } });
  });
  it('keeps an unobserved artifact or context unknown and an observed absence a measured zero', async () => {
    expect(await evaluateQuestionnaire(check, context([], { artifacts: {} }).context)).toMatchObject({ status: 'unknown' });
    expect(await evaluateQuestionnaire(check, context([], { artifacts: {}, subjectUsage: { status: 'complete', usage: null, settled: true } }).context))
      .toMatchObject({ status: 'fail', score: 0 });
    const { strong, context: evaluation } = context(testReplies, { context: { assignment: 'only' } });
    expect(await evaluateQuestionnaire(check, evaluation)).toMatchObject({ status: 'unknown', reason: 'Questionnaire context evidence was not observed' });
    expect(strong.prompts).toHaveLength(0);
  });
  it('fits the stage score and gate model beside mechanical checks', async () => {
    const dataset = resolveDataset(parseDatasetYaml(JSON.stringify({ schema: 'spawnfile.training.dataset.v1', id: 'd',
      records: [{ id: 'r', input: { prompt: 'Write' }, outputs: { article: 'article.json' }, context: testMaterial.context,
        stages: [{ id: 'record-checks', checks: [check, { id: 'length', eval: 'word-count', input: 'artifact:article#/body', min: 1, max: 50 }],
          score: { linear: { 'house-rules': 0.75, length: 0.25 } }, gate: { all: [{ passed: 'house-rules' }] } }] }],
    }), { sourceName: '/project/dataset.yaml' }), { readCriterionFile: () => testBankYaml, registry: { judges: { strong: { version: '1' } } } });
    const { context: evaluation } = context(testReplies);
    const plan = await evaluatePlan(dataset.records[0]!.effectiveStages, evaluation, createEvaluationRegistry());
    expect(plan.status).toBe('pass');
    expect(plan.stages[0]!.score!.lower).toBeCloseTo(0.75 * 0.6875 + 0.25);
    expect(dataset.criterionFileDigests['bank.yaml']).toMatch(/^sha256:/u);
    expect(dataset.registryVersions['judge:strong']).toBe('1');
  });
});
