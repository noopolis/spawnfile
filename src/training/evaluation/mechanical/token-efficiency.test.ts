import { describe, expect, it } from 'vitest';
import type { CheckNode, Stage } from '../../contracts/dataset.js';
import type { EvaluationSnapshot } from '../../contracts/evaluation.js';
import type { Usage } from '../../contracts/execution.js';
import { evaluationContext, snapshot } from '../../testing/index.js';
import { createEvaluationRegistry, evaluateNode, evaluatePlan, mayStop, result } from '../index.js';
import { evaluateTokenEfficiency } from './index.js';

const registry = createEvaluationRegistry();
const check: CheckNode = { eval: 'token-efficiency', metric: 'total', target_tokens: 1000 };
const usage: Usage = { inputTokens: 800, cachedInputTokens: 500, cacheWriteInputTokens: 100,
  outputTokens: 200, reasoningTokens: 150, source: 'native-total' };
const captured = (patch: Partial<Usage> = {}, extra: Partial<EvaluationSnapshot> = {}) => evaluationContext({
  snapshot: snapshot({ subjectUsage: { status: 'complete', usage: { ...usage, ...patch } }, ...extra }),
});

describe('complete native subject token efficiency', () => {
  it.each([['input', 1 / 1.8], ['output', 1 / 1.2], ['total', 0.5]])('scores %s without adding cached or reasoning subsets', async (metric, score) => {
    const evaluated = await evaluateNode({ ...check, metric }, captured(), registry);
    expect(evaluated).toMatchObject({ status: 'pass', finality: 'final', score });
    expect(evaluated.reason).toContain(`reference=1000`);
  });
  it('uses a continuous reference, not a cap, and handles zero and safe large totals', async () => {
    const measure = (inputTokens: number, outputTokens = 0, target_tokens = 1000) =>
      evaluateNode({ ...check, target_tokens }, captured({ inputTokens, outputTokens, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0 }), registry);
    expect((await measure(0)).score).toBe(1);
    expect((await measure(1000)).score).toBe(0.5);
    expect(await measure(3000)).toMatchObject({ status: 'pass', score: 0.25 });
    expect((await measure(Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER)).score).toBe(0.5);
    expect((await measure(Number.MAX_SAFE_INTEGER, 0, 1)).score).toBeGreaterThan(0);
    expect((await measure(Number.MAX_SAFE_INTEGER, 1)).score).toBeUndefined();
  });
  it('never rewards missing legacy, incomplete or provisional usage as zero', async () => {
    for (const subjectUsage of [undefined, { status: 'incomplete' as const, usage }, { status: 'incomplete' as const, usage, settled: true }, { status: 'complete' as const, usage: null }]) {
      const evaluated = await evaluateNode(check, evaluationContext({ snapshot: snapshot({ subjectUsage }) }), registry);
      expect(evaluated).toMatchObject({ status: 'unknown', finality: 'final' }); expect(evaluated.score).toBeUndefined();
    }
    const live = await evaluateNode(check, captured({}, { closed: false }), registry);
    expect(live).toMatchObject({ status: 'unknown', finality: 'provisional' }); expect(live.score).toBeUndefined();
    expect(() => mayStop({ ...check, id: 'watch', on: 'event', on_fail: 'stop' }, registry)).toThrow('finality');
  });
  it.each([null, undefined, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '5'])('does not score an invalid relevant token count %s', async value => {
    for (const metric of ['input', 'total']) {
      const evaluated = await evaluateNode({ ...check, metric }, captured({ inputTokens: value as number }), registry);
      expect(evaluated.status).toBe('unknown'); expect(evaluated.score).toBeUndefined();
    }
    const output = await evaluateNode({ ...check, metric: 'output' }, captured({ outputTokens: value as number }), registry);
    expect(output.status).toBe('unknown'); expect(output.score).toBeUndefined();
  });
  it('requires only the totals relevant to the chosen metric', async () => {
    expect((await evaluateNode({ ...check, metric: 'input' }, captured({ outputTokens: null }), registry)).status).toBe('pass');
    expect((await evaluateNode({ ...check, metric: 'output' }, captured({ inputTokens: null }), registry)).status).toBe('pass');
  });
  it.each([{ target_tokens: 0 }, { target_tokens: -1 }, { target_tokens: 1.5 }, { target_tokens: Number.NaN },
    { target_tokens: Number.MAX_SAFE_INTEGER + 1 }, { metric: 'cached' }, { metric: ['input'] }])('rejects invalid direct evaluator controls without a score', async patch => {
    const evaluated = await evaluateTokenEfficiency({ ...check, ...patch }, captured());
    expect(evaluated.status).toBe('error'); expect(evaluated.score).toBeUndefined();
  });
  it('keeps quality floors independent of 52/28/20 weighted efficiency', async () => {
    const scored = createEvaluationRegistry({ 'fixture-quality': {
      definition: { version: 'fixture', kind: 'mechanical', incremental: false, stopProof: false, validate() {} },
      async evaluate(node) { const score = node.value as number; return { ...result(score >= (node.minimum as number) ? 'pass' : 'fail', 'fixture quality'), score }; },
    } });
    const stage: Stage = { id: 'writing', checks: [
      { id: 'grounded', eval: 'fixture-quality', value: 0.95, minimum: 0.90 },
      { id: 'prose', eval: 'fixture-quality', value: 0.90, minimum: 0.80 },
      { ...check, id: 'efficiency' }], score: { linear: { grounded: 52, prose: 28, efficiency: 20 } },
      gate: { all: [{ passed: 'grounded' }, { passed: 'prose' }] } };
    const evaluated = await evaluatePlan([stage], captured(), scored);
    expect(evaluated.status).toBe('pass'); expect(evaluated.scores['writing']!.lower).toBeCloseTo(0.846);
    stage.checks[0]!.value = 0.89;
    const cheaper = await evaluatePlan([stage], captured({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0 }), scored);
    expect(cheaper.checks['efficiency']!.score).toBe(1); expect(cheaper.status).toBe('fail');
    const missing = await evaluatePlan([stage], evaluationContext(), scored);
    expect(missing.scores['writing']!.missingWeight).toBeCloseTo(0.20);
  });
});
