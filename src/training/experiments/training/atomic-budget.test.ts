import { expect, it, vi } from 'vitest';
import { parseAtomicGrader, type AtomicRuntime } from '../../graders/atomic/index.js';
import { parseCheckTemplates, parseDecomposition } from '../../graders/decomposition/index.js';
import { createDecisionSpendBudget, createTypeSafeDecision } from '../../inference/decision/index.js';
import { createEvaluationRegistry, evaluatePlan } from '../../evaluation/index.js';
import { artifact, evaluationContext, snapshot } from '../../testing/index.js';
import type { CheckNode } from '../../contracts/dataset.js';
import { trialScore } from './scoring.js';

function fixture(missing: 'fail' | 'unknown', httpStatus?: number) {
  const model = 'jev-1.0.0';
  const grader = parseAtomicGrader({ schema: 'paideia.atomic-grader.v1', id: 'quality', templates: 'templates.yaml',
    extractor: { provider: 'codex', model: 'test' }, decision: { backend: 'typesafe', model, max_spend_usd: 1 }, missing,
    aggregation: { method: 'gates-times-coverage-times-quality', critical_pass_at: 0.8, pass_at: 0.5, obligation_kinds: ['obligation'],
      dimensions: { coverage: { weight: 1, budget: 2 } }, penalties: { critical: 1, major: 0.5, minor: 0.1 } } });
  const templates = parseCheckTemplates({ schema: 'paideia.check-templates.v1', context: { assignment: { role: 'assignment' } },
    templates: [{ id: 'covered', applies_to: 'obligation', type: 'noul', instructions: 'Covered?', criteria: { true: 'Good', false: 'Bad' },
      expected: [true], state: ['unit', 'output.body'], dimension: 'coverage', severity: 'major' }] });
  const budget = createDecisionSpendBudget();
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    if (httpStatus) return new Response('untrusted response body', { status: httpStatus });
    const body = JSON.parse(init!.body as string);
    return Response.json({ model, answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { type: 'noul', noul: 1 }])) });
  });
  const receipt = { provider: 'codex', model: 'test', prompt_digest: 'c'.repeat(64), at: '2026-10-14T00:00:00Z' };
  const runtime: AtomicRuntime = { kind: 'atomic', grader, templates, definitionDigest: 'a'.repeat(64), templatesDigest: 'b'.repeat(64), resource: {},
    backend: createTypeSafeDecision({ model, env: { TYPESAFE_API_KEY: 'offline-key' }, fetch, budget, conservativeSpend: true }),
    extract: vi.fn(async () => ({ decomposition: parseDecomposition({ schema: 'paideia.decomposition.v1', output: { from: 'trial', sha256: 'c'.repeat(64) },
      units: [{ id: 'one', kind: 'obligation', text: 'Cover Alice.' }], extractors: [receipt], audit: { extractor: receipt, missed: [], at: receipt.at } }),
    receipts: [], judgeCalls: [] })) };
  const check = { id: 'quality', eval: 'grader', grader: '/grader.yaml', input: 'artifact:article', context: { assignment: 'artifact:assignment' },
    grader_binding: { kind: 'atomic', definitionDigest: runtime.definitionDigest, templatesDigest: runtime.templatesDigest, gates: [] } };
  const context = evaluationContext({ graders: { '/grader.yaml': runtime }, snapshot: snapshot({ artifacts: {
    article: artifact({ body: ['Alice joined.'] }), assignment: { ...artifact('Cover Alice.'), name: 'assignment' },
  } }) });
  async function measure(extra: CheckNode[] = [], nested = false, gate?: CheckNode) {
    const quality = nested ? { id: 'quality', all: [check] } : check;
    const evaluation = await evaluatePlan([{ id: 'terminal', checks: [quality, ...extra], ...(gate ? { gate } : {}) }], context, createEvaluationRegistry());
    const report: Parameters<typeof trialScore>[0] = { id: 'trial', execution: 'completed', hostWork: 'settled',
      stop: { state: 'acknowledged', scope: 'native-handle', quiescence: 'confirmed', remoteWork: 'unknown', reason: 'Fixture closed', detail: 'Offline fixture' },
      status: evaluation.status, evaluation };
    return report;
  }
  return { measure, fetch, budget, runtime };
}

it.each(['fail', 'unknown'] as const)('never rewards identical input with zero after shared budget exhaustion (%s)', async missing => {
  const f = fixture(missing);
  const first = await f.measure();
  expect(trialScore(first)).toBe(1); expect(f.fetch).toHaveBeenCalledTimes(1);
  f.budget.maxUsd = f.budget.spentUsd; // Exactly one completed invocation's allowance; unknown usage remains charged.
  for (let attempt = 0; attempt < 2; attempt++) {
    const exhausted = await f.measure();
    const check = exhausted.evaluation.checks.quality!;
    expect(exhausted.status).toBe('error'); expect(check.score).toBeUndefined();
    expect(check.reason).toContain('spend cap');
    expect(check.atomicGrading).toMatchObject({ status: 'error', score: null, receipts: [], failure: { cause: 'spend-cap', reason: 'spend cap' } });
    expect(check.atomicGrading!.checks[0]!.decision).toMatchObject({ status: 'missing', reason: 'spend cap', failureCause: 'spend-cap' });
    expect(() => trialScore(exhausted)).toThrow('unscorable');
  }
  expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.runtime.extract).toHaveBeenCalledTimes(3);
  // A logical sibling failure or custom gate may hide the error at the aggregate level.
  const sibling = { id: 'other', eval: 'equals', input: 'output.text', value: 'different' };
  const failed = await f.measure([sibling]);
  expect(failed.status).toBe('fail');
  expect(() => trialScore(failed)).toThrow('unscorable atomic grading measurement');
  // Explicitly decisive gate: the original criterion remains unscorable even if aggregate verdict is pass.
  const hidden = await f.measure([], true, { eval: 'equals', input: 'output.text', value: '4' });
  expect(hidden.status).toBe('pass');
  expect(hidden.evaluation.checks.quality!.atomicGrading).toBeUndefined();
  expect(hidden.evaluation.checks.quality!.children![0]!.atomicGrading!.failure!.cause).toBe('spend-cap');
  expect(() => trialScore(hidden)).toThrow('unscorable atomic grading measurement');
});


it.each(['fail', 'unknown'] as const)('rejects payment errors masked by sibling failures or passing gates (%s)', async missing => {
  const f = fixture(missing, 402);
  const sibling = { id: 'other', eval: 'equals', input: 'output.text', value: 'different' };
  const failed = await f.measure([sibling]);
  expect(failed.status).toBe('fail');
  expect(failed.evaluation.checks.quality!.atomicGrading).toMatchObject({ status: 'error', score: null, receipts: [{ status: 402 }] });
  expect(() => trialScore(failed)).toThrow('unscorable atomic grading measurement');
  const hidden = await f.measure([], true, { eval: 'equals', input: 'output.text', value: '4' });
  expect(hidden.status).toBe('pass');
  expect(hidden.evaluation.checks.quality!.children![0]!.atomicGrading!.status).toBe('error');
  expect(() => trialScore(hidden)).toThrow('unscorable atomic grading measurement');
  expect(f.fetch).toHaveBeenCalledTimes(2);
});

it.each([400, 403, 404, 413, 422])('preserves HTTP %i as infrastructure through real grading and scoring', async status => {
  for (const missing of ['fail', 'unknown'] as const) {
    const f = fixture(missing, status);
    const report = await f.measure();
    const grade = report.evaluation.checks.quality!.atomicGrading!;
    expect(report.status).toBe('error');
    expect(grade).toMatchObject({ status: 'error', score: null,
      failure: { cause: 'request-rejected', reason: `TypeSafe HTTP ${status}: request rejected` }, receipts: [{ status }] });
    expect(grade.checks[0]!.decision).toMatchObject({ status: 'missing', failureCause: 'request-rejected' });
    expect(report.evaluation.checks.quality!.score).toBeUndefined();
    expect(() => trialScore(report)).toThrow('unscorable');
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.budget.reservedUsd).toBe(0);
  }
});
