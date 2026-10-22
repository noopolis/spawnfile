import { expect, it, vi } from 'vitest';
import type { CheckNode, Stage } from '../../contracts/dataset.js';
import type { EvaluationResult } from '../../contracts/evaluation.js';
import type { DecisionRequestReceipt } from '../../contracts/grading.js';
import { createCalibrationIdentity, decisionBackendIdentity, parseGrader, summarizeDecisionAccounting, type GradingRuntime } from '../../graders/index.js';
import { createTypeSafeDecision } from '../../inference/decision/index.js';
import { createEvaluationRegistry, evaluatePlan, result } from '../../evaluation/index.js';
import { artifact, evaluationContext, snapshot } from '../../testing/index.js';
import { capturedTrial } from '../replay/index.js';
import type { TrialReport } from '../trials/index.js';
import type { RescoreReport } from '../replay/index.js';
import { includeDecisionCosts, summarizeCosts } from './report.js';

const receipt: DecisionRequestReceipt = { billing: 'api', model: 'jev-1.13.0', endpoint: 'https://example.test',
  inputTokens: 500, outputTokens: 0, usd: 0.021, estimatedInputTokens: 1000, estimatedUsd: 0.2, latencyMs: 5, status: 200 };
function graded(id = 'writing'): EvaluationResult {
  const digest = 'a'.repeat(64);
  return { id, status: 'pass', finality: 'final', reason: 'Synthetic grading', evidence: [], grading: {
    status: 'pass', score: 1, coverage: 1, gates: [], questions: [], judgeCalls: [], backendBilling: 'api',
    identity: { calibration: { expansion: [], questions: {}, promptTemplateVersion: 'v1', segmenter: 'test',
      optionMapping: {}, backendModel: receipt.model, golden: digest, seed: 's', exclusions: [], escalation: digest,
      escalationTeacher: digest, uncalibrated: 'refuse' }, calibrationDigest: digest, escalation: digest, teacherPolicy: digest, scoringPolicy: digest },
    decisionAccounting: { billing: 'api', requests: 2, inputTokens: 1000, outputTokens: 0, usd: 0.042,
      latencyMs: { p50: 5, p95: 5 }, receipts: [{ ...receipt }, { ...receipt }] } } };
}
function trial(): TrialReport {
  const check = graded();
  return { schema: 'paideia.trial.v1', id: 'trial', phase: 'train', candidateId: 'baseline', datasetDigest: 'dataset',
    planDigest: 'plan', recordId: 'record', paths: { root: '/trial', workspace: '/trial/work', control: '/trial/control', runtimeHome: '/trial/runtime' },
    status: 'pass', execution: 'completed', hostWork: 'settled', turns: [], live: [],
    snapshot: { trialId: 'trial', recordId: 'record', closed: true, events: [], coverage: [], artifacts: {}, output: '', inputFiles: {}, context: {} },
    evaluation: { status: 'pass', scores: {}, checks: { writing: check },
      stages: [{ id: 'quality', checks: [structuredClone(check)], gate: {
        status: 'pass', finality: 'final', reason: 'Combined', evidence: [], children: [structuredClone(check)] } }] } };
}
const options = { subjectModel: 'unknown' };

function persistedTrial(input: TrialReport): TrialReport {
  return capturedTrial({ manifest: { schema: 'paideia.run.v1', id: input.id, datasetId: 'dataset',
    datasetRole: input.phase, candidateId: input.candidateId, planDigest: input.planDigest, recordId: input.recordId },
    events: [], evaluations: [{ id: 'original', visibility: 'evaluator', digest: 'digest', report: JSON.parse(JSON.stringify(input)) }],
    completeness: 'complete', ignoredTailBytes: 0, redactedEvents: 0, redactedMetadata: false }).report;
}

it('counts receipt ordinals once across persisted plan copies, retaining identically priced distinct requests', () => {
  const input = trial(), before = structuredClone(input);
  const costs = summarizeCosts([input, structuredClone(input)], options);
  expect(costs.entries).toHaveLength(2);
  expect(costs.entries.map(entry => entry.decisionReceipt)).toEqual([receipt, receipt]);
  expect(costs.knownSubtotalUsd).toEqual({ low: 0.042, high: 0.042 });
  expect(costs.groups[0]).toMatchObject({ role: 'judge', entryCount: 2, completeness: 'complete' });
  expect(includeDecisionCosts(costs, [input])).toBe(costs);
  expect(input).toEqual(before);
});

it('retains origin without property-order conflicts through persistence of injected backend receipts', () => {
  const input = trial(); input.evaluation.stages = [];
  const grade = input.evaluation.checks.writing!.grading!;
  grade.decisionAccounting = summarizeDecisionAccounting(grade.decisionAccounting!.receipts);
  const persisted = persistedTrial(input);
  // Schema field order differs from the original backend's object insertion order.
  expect(Object.keys(persisted.evaluation.checks.writing!.grading!.decisionAccounting!.receipts[0]!))
    .not.toEqual(Object.keys(grade.decisionAccounting.receipts[0]!));
  const costs = summarizeCosts([input, persisted], options);
  expect(costs.entries).toHaveLength(2);
  expect(costs.entries.every(entry => entry.decisionReceiptVersions === undefined)).toBe(true);
  expect(costs.knownSubtotalUsd).toEqual({ low: 0.042, high: 0.042 });
  persisted.evaluation.checks.writing!.grading!.decisionAccounting!.receipts[0]!.usd = 0.5;
  const conflict = summarizeCosts([input, persisted], options);
  expect(conflict.entries[0]!.decisionReceiptVersions).toHaveLength(2);
  expect(conflict.entries[0]!.valuation.apiEquivalentUsd).toBeNull();
});

it('counts separate checks, nested anonymous leaves, native trials and rescoring even with identical amounts', () => {
  const input = trial();
  input.evaluation.checks.other = graded('other');
  const anonymous = graded(); delete anonymous.id;
  input.evaluation.checks.nested = { ...anonymous, grading: undefined, children: [anonymous, structuredClone(anonymous)] };
  const second = { ...structuredClone(input), id: 'second' };
  const rescore: RescoreReport = { schema: 'paideia.rescore.v1', id: 'rescore', runId: input.id, scope: 'final-stages',
    notReevaluated: ['live', 'per-turn'], original: { evaluationId: 'original', digest: 'digest', candidateId: input.candidateId,
      datasetDigest: 'dataset', planDigest: 'plan', recordId: input.recordId, phase: input.phase, status: input.status },
    criteria: { datasetId: 'dataset', datasetDigest: 'digest', sharedPlanDigest: 'plan', stages: [], registryVersions: {},
      sidecarDigests: {}, inferenceRoutes: { judges: {}, embeddings: {} } }, execution: 'completed', hostWork: 'settled',
    coverage: [], status: 'pass', evaluation: trial().evaluation };
  const costs = summarizeCosts([input, second], { ...options, rescores: [rescore, structuredClone(rescore)] });
  expect(costs.entries).toHaveLength(18);
  expect(costs.knownSubtotalUsd.low).toBeCloseTo(18 * receipt.usd!);
  expect(new Set(costs.entries.map(entry => entry.id)).size).toBe(18);
});

it('retains null-price failed requests without substituting admission estimates', () => {
  const input = trial(); input.evaluation.stages = [];
  input.evaluation.checks.writing!.grading!.decisionAccounting!.receipts[1] = {
    ...receipt, usd: null, inputTokens: null, outputTokens: null, status: 500 };
  const costs = summarizeCosts([input], options);
  expect(costs.entries).toHaveLength(2);
  expect(costs.entries[1]).toMatchObject({ decisionReceipt: { usd: null, estimatedUsd: 0.2, status: 500 },
    valuation: { apiEquivalentUsd: null, status: 'incomplete' } });
  expect(costs.knownSubtotalUsd.low).toBe(0.021);
  expect(costs.apiEquivalentUsd).toBeNull();
});

it('retains conflicting copies as unknown instead of summing or choosing a receipt', () => {
  const input = trial();
  input.evaluation.stages[0]!.checks[0]!.grading!.decisionAccounting!.receipts[0]!.usd = 0.5;
  const costs = summarizeCosts([input], options);
  expect(costs.entries).toHaveLength(2);
  expect(costs.entries[0]!.decisionReceiptVersions).toHaveLength(2);
  expect(costs.entries[0]!.valuation.apiEquivalentUsd).toBeNull();
  expect(costs.entries[0]!.valuation.assumptions[0]).toContain('Conflicting');
  expect(costs.knownSubtotalUsd.low).toBe(0.021);
});

it('retains turn and live grading costs while counting the decisive failure reference only once', () => {
  const input = trial(); input.evaluation = { status: 'pass', scores: {}, stages: [], checks: {} };
  input.turns = [{ id: 'wake', checks: [graded()], native: { status: 'completed', text: '', usage: null, coverage: [] } }];
  input.live = [{ checkId: 'writing', boundary: 'close', result: graded() }];
  input.decisiveFailure = structuredClone(input.live[0]!.result);
  const costs = summarizeCosts([input], options);
  expect(costs.entries.filter(entry => entry.role === 'judge')).toHaveLength(4);
  input.live = [];
  expect(summarizeCosts([input], options).entries.filter(entry => entry.role === 'judge')).toHaveLength(4);
  expect(includeDecisionCosts(null, [])).toBeNull();
});

async function engineFixture() {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const body = JSON.parse(String(init!.body)) as { questions: Record<string, unknown> };
    return Response.json({ model: receipt.model,
      answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: 0.9 }])),
      usage: { input_tokens: 500, output_tokens: 0 } });
  });
  const backend = createTypeSafeDecision({ model: receipt.model, env: { TYPESAFE_API_KEY: 'synthetic-test-key' },
    fetch, pricePerMtokUsd: 42, retryBaseMs: 0, maxAttempts: 2 });
  const grader = parseGrader({ schema: 'paideia.grader.v1', id: 'g', golden: 'g.yaml', calibration: 'c.json',
    model: { backend: 'typesafe', name: receipt.model }, teachers: [{ id: 't', provider: 'claude', model: 'm' }],
    escalate: { to: 't', between: [0.4, 0.6] },
    questions: [{ id: 'q', type: 'yes-no', level: 'paragraph', expected: 'yes', reads: ['paragraph'] }],
    score: { method: 'weighted', pass_at: 0.7 } });
  const digest = 'a'.repeat(64), goldenDigest = digest;
  const runtime: GradingRuntime = { grader, backend, goldenDigest, promptTemplateVersion: 'v1', resource: {},
    definitionDigest: digest, calibrationDigest: digest,
    calibration: { schema: 'paideia.grader-calibration.v1',
      identity: createCalibrationIdentity(grader, { backendModel: await decisionBackendIdentity(grader, backend),
        golden: goldenDigest, promptTemplateVersion: 'v1', seed: 's', exclusions: [] }),
      questions: { q: { status: 'calibrated', failures: [], params: { a: 1, b: 0 }, band: [0.4, 0.6],
        metrics: { groups: 20, instances: 40, good: 20, bad: 20, baseRate: 0.5 } } } } };
  const context = evaluationContext({ graders: { '/grader.yaml': runtime },
    snapshot: snapshot({ artifacts: { article: artifact({ body: ['First paragraph.', 'Second paragraph.'] }) } }) });
  const check: CheckNode = { id: 'writing', eval: 'grader', grader: '/grader.yaml', input: 'artifact:article',
    grader_binding: { definitionDigest: digest, calibrationDigest: digest, gates: [] } };
  return { context, check, fetch };
}

it('counts originating requests once through named passed references and persisted engine results', async () => {
  const f = await engineFixture();
  const stages: Stage[] = [{ id: 'quality', checks: [f.check, { id: 'alias', passed: 'writing' }],
    gate: { id: 'release', passed: 'alias' } }];
  const input = trial();
  input.evaluation = await evaluatePlan(stages, f.context, createEvaluationRegistry());
  expect(input.evaluation.status).toBe('pass');
  expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(input.evaluation.checks.alias!.grading!.decisionAccounting!.requests).toBe(2);
  const persisted = persistedTrial(input);
  const costs = summarizeCosts([persisted], options);
  expect(costs.entries).toHaveLength(2);
  expect(costs.knownSubtotalUsd).toEqual({ low: 0.042, high: 0.042 });
  expect(new Set(costs.entries.map(entry => entry.decisionReceipt!.requestId)).size).toBe(2);
  expect(costs.entries.every(entry => typeof entry.decisionReceipt!.requestId === 'string')).toBe(true);
});

it('retains receipt origin across selective repair while charging fresh rescoring and equal-price checks', async () => {
  const f = await engineFixture();
  let broken = true;
  const semantic = vi.fn(async () => ({ ...result(broken ? 'error' : 'pass', 'Repairable semantic check'),
    judgeCalls: [{ id: broken ? 'failed-semantic' : 'repaired-semantic', judge: 'fixture', providerId: 'fixture',
      requestedModel: 'fixture', responseModel: null, responseRoute: null, usage: null,
      outcome: broken ? 'generation-error' as const : 'completed' as const }] }));
  const registry = createEvaluationRegistry({ repairable: { definition: { version: '1', kind: 'semantic',
    incremental: false, stopProof: false, validate() {} }, evaluate: semantic } });
  const stages: Stage[] = [{ id: 'quality', checks: [f.check, { id: 'broken', eval: 'repairable' }] }];
  const input = trial(); input.evaluation = await evaluatePlan(stages, f.context, registry);
  expect(input.evaluation.status).toBe('error');
  const original = persistedTrial(input);
  broken = false; semantic.mockClear();
  const repaired = await evaluatePlan(stages, f.context, registry, {
    originalStages: stages, original: original.evaluation, errorPaths: ['/stages/0/checks/1'] });
  expect(semantic).toHaveBeenCalledTimes(1);
  expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(repaired.checks.writing).toEqual(original.evaluation.checks.writing);
  const rescore: RescoreReport = { schema: 'paideia.rescore.v1', id: 'repair', runId: input.id, scope: 'final-stages',
    notReevaluated: ['live', 'per-turn'], original: { evaluationId: 'original', digest: 'digest', candidateId: input.candidateId,
      datasetDigest: input.datasetDigest, planDigest: input.planDigest, recordId: input.recordId, phase: input.phase, status: input.status },
    criteria: { datasetId: 'dataset', datasetDigest: 'digest', sharedPlanDigest: 'plan', stages: [], registryVersions: {},
      sidecarDigests: {}, inferenceRoutes: { judges: {}, embeddings: {} } }, execution: 'completed', hostWork: 'settled',
    coverage: [], status: repaired.status, evaluation: repaired };
  const decisions = (value: ReturnType<typeof summarizeCosts>) => value.entries.filter(entry => entry.decisionReceipt);
  const costs = summarizeCosts([original], { ...options, rescores: [rescore] });
  expect(decisions(costs)).toHaveLength(2);
  expect(costs.knownSubtotalUsd).toEqual({ low: 0.042, high: 0.042 });
  expect(includeDecisionCosts(costs, [original], [rescore])).toBe(costs);
  // Ordinary rescoring dispatches new requests; it must not be merged by amount.
  const fresh = await evaluatePlan(stages, f.context, registry);
  const independent = await evaluatePlan([{ id: 'other-stage', checks: [{ ...f.check, id: 'other-check' }] }], f.context, registry);
  const later = summarizeCosts([original, { ...input, id: 'other-trial', evaluation: independent }], {
    ...options, rescores: [rescore, { ...rescore, id: 'fresh', evaluation: fresh }] });
  expect(f.fetch).toHaveBeenCalledTimes(6);
  expect(decisions(later)).toHaveLength(6);
  expect(later.knownSubtotalUsd.low).toBeCloseTo(0.126);
});


it.each(['model-drift', 'exhausted-retries'] as const)('retains failed paid attempts through engine, replay and later reports: %s', async mode => {
  const f = await engineFixture();
  f.context.snapshot = snapshot({ artifacts: { article: artifact({ body: ['Only paragraph.'] }) } });
  f.fetch.mockImplementation(async () => mode === 'model-drift'
    ? Response.json({ model: 'wrong-model', answers: {}, usage: { input_tokens: 500, output_tokens: 0 } })
    : new Response('', { status: 503 }));
  const input = trial();
  input.evaluation = await evaluatePlan([{ id: 'quality', checks: [f.check, { id: 'alias', passed: 'writing' }] }], f.context, createEvaluationRegistry());
  expect(input.evaluation.status).toBe('error');
  const expected = mode === 'model-drift' ? 1 : 2;
  expect(f.fetch).toHaveBeenCalledTimes(expected);
  expect(input.evaluation.checks.writing).toMatchObject({ status: 'error', decisionAccounting: { requests: expected } });
  expect(input.evaluation.checks.writing!.grading).toBeUndefined();
  const persisted = persistedTrial(input);
  expect(persisted.evaluation.checks.writing!.decisionAccounting).toEqual(input.evaluation.checks.writing!.decisionAccounting);
  const costs = summarizeCosts([persisted], options);
  expect(costs.entries).toHaveLength(expected);
  expect(new Set(costs.entries.map(entry => entry.decisionReceipt!.requestId)).size).toBe(expected);
  expect(costs.knownSubtotalUsd.low).toBe(mode === 'model-drift' ? 0.021 : 0);
  expect(costs.entries.every(entry => entry.decisionReceipt!.usd === null)).toBe(mode === 'exhausted-retries');
  // A later repaired measurement does not remove earlier failed attempts.
  const repaired: RescoreReport = { schema: 'paideia.rescore.v1', id: 'repair', runId: input.id, scope: 'final-stages',
    notReevaluated: ['live', 'per-turn'], original: { evaluationId: 'original', digest: 'digest', candidateId: input.candidateId,
      datasetDigest: input.datasetDigest, planDigest: input.planDigest, recordId: input.recordId, phase: input.phase, status: input.status },
    criteria: { datasetId: 'dataset', datasetDigest: 'digest', sharedPlanDigest: 'plan', stages: [], registryVersions: {},
      sidecarDigests: {}, inferenceRoutes: { judges: {}, embeddings: {} } }, execution: 'completed', hostWork: 'settled',
    coverage: [], status: 'pass', evaluation: { status: 'pass', checks: {}, scores: {}, stages: [] } };
  expect(includeDecisionCosts(null, [persisted], [repaired])!.entries).toHaveLength(expected);
});
