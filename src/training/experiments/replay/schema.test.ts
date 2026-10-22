import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { snapshotCandidate } from '../../candidates/index.js';
import { expect, test } from 'vitest';
import type { JudgeCall } from '../../contracts/evaluation.js';
import type { Usage } from '../../contracts/execution.js';
import type { GradeResult } from '../../graders/index.js';
import { capturedTrial } from './source.js';
import { fixture } from './fixture.js';
import { trialReportSchema } from './schema.js';
import { trialScore } from '../training/index.js';
import { summarizeCosts } from '../costs/index.js';
import { createTypeSafeDecision } from '../../inference/decision/index.js';

test('replay validates optional pre-deferral verdicts and preserves legacy report shape', async () => {
  const { store, options, report } = await fixture();
  const legacy = capturedTrial(await store.readReplay(options.runId, options.access)).report;
  expect(legacy).not.toHaveProperty('preDeferralStatus');
  expect(legacy).toStrictEqual(report);
  const legacyBytes = JSON.stringify(trialReportSchema.parse(report));
  expect(JSON.stringify(trialReportSchema.parse({ ...report, preDeferralStatus: undefined }))).toBe(legacyBytes);
  for (const preDeferralStatus of ['pass', 'fail', 'unknown', 'error', 'skipped'] as const) {
    expect(trialReportSchema.parse({ ...report, preDeferralStatus }).preDeferralStatus).toBe(preDeferralStatus);
  }
  for (const preDeferralStatus of ['completed', '', null, true, 1, {}]) {
    expect(() => trialReportSchema.parse({ ...report, preDeferralStatus })).toThrow();
  }
});

test('replay validates failure classifications without adding them to legacy reports', async () => {
  const { report } = await fixture();
  const legacyBytes = JSON.stringify(trialReportSchema.parse(report));
  expect(trialReportSchema.parse(report)).not.toHaveProperty('failureKind');
  expect(JSON.stringify(trialReportSchema.parse({ ...report, failureKind: undefined }))).toBe(legacyBytes);
  for (const failureKind of ['native-infrastructure', 'behavioral', 'measurement'] as const) {
    const stored = await fixture(report => { report.execution = 'failed'; report.failureKind = failureKind; });
    expect(capturedTrial(await stored.store.readReplay(stored.options.runId, stored.options.access)).report).toEqual(stored.report);
    expect(trialReportSchema.parse(stored.report).failureKind).toBe(failureKind);
  }
  for (const failureKind of ['failed', '', null, true, 1, {}]) {
    expect(() => trialReportSchema.parse({ ...report, failureKind })).toThrow();
  }
});

test('replay retains collection failures and neutral admission counters for resume', async () => {
  const { store, options, report } = await fixture(report => {
    report.execution = 'failed'; report.failureKind = 'native-infrastructure'; report.collectionFailed = true;
    report.turns[0]!.native.admission = { executionRecords: 0, executionsUsed: 0, agentExecutionsUsed: 0,
      tokensUsed: 0, agentTokensUsed: 0, toolEvents: 0, outputEvents: 0 };
  });
  expect(capturedTrial(await store.readReplay(options.runId, options.access)).report).toEqual(report);
  for (const value of [undefined, null, 1, -1, '0']) {
    const modified = structuredClone(report);
    modified.turns[0]!.native.admission!.agentTokensUsed = value as number;
    if (value === null || value === 1) expect(trialReportSchema.parse(modified)).toEqual(modified);
    else expect(() => trialReportSchema.parse(modified)).toThrow();
  }
  expect(() => trialReportSchema.parse({ ...report, collectionFailed: false })).toThrow();
});

test('replay preserves atomic acceptance-gate failures without fabricating a grade', async () => {
  const { store, options, report } = await fixture(report => {
    const atomic = { status: 'error' as const, finality: 'final' as const, reason: 'Gate failed', evidence: [],
      atomicFailure: { cause: 'acceptance-gate' as const, gateId: 'accepted' } };
    const masked = { ...report.evaluation.checks.old!, children: [atomic] };
    report.evaluation.checks.old = masked;
    report.evaluation.stages[0]!.checks = [masked];
    report.evaluation.stages[0]!.gate = masked;
    report.turns[0]!.checks = [masked];
    report.live = [{ checkId: 'quality', boundary: 'event', result: masked }];
  });
  const captured = capturedTrial(await store.readReplay(options.runId, options.access));
  expect(captured.report).toEqual(report);
  expect(() => trialScore(captured.report)).toThrow('unscorable atomic grading measurement');
  for (const atomicFailure of [{ cause: 'invented', gateId: 'accepted' }, { cause: 'acceptance-gate', gateId: '' }, { cause: 'acceptance-gate' }]) {
    const malformed = { ...report, evaluation: { ...report.evaluation,
      checks: { old: { ...report.evaluation.checks.old!, atomicFailure } } } };
    expect(() => trialReportSchema.parse(malformed)).toThrow();
  }
});

const usage: Usage = { inputTokens: 40, cachedInputTokens: 10, cacheWriteInputTokens: 6,
  cacheWrite5mInputTokens: 2, cacheWrite1hInputTokens: 4,
  outputTokens: 8, reasoningTokens: null, source: 'native' };
const call: JudgeCall = { id: 'actual-generation', judge: 'editor', providerId: 'selected-provider',
  requestedModel: 'requested-alias', responseModel: 'reported-model', responseRoute: 'reported-route',
  outcome: 'invalid-response', usage, wallMs: 125.5, billing: 'subscription' };

test('replay retains judge attribution and cache-write usage across stored report surfaces', async () => {
  const { report } = await fixture(report => {
    const judged = { ...report.evaluation.checks.old!, usage: [usage], judgeCalls: [call] };
    report.evaluation.judgeCalls = [call];
    report.evaluation.checks.old = judged;
    report.evaluation.stages[0]!.checks = [judged];
    report.evaluation.stages[0]!.gate = judged;
    report.turns[0]!.native.usage = usage;
    report.turns[0]!.checks = [judged];
    report.live = [{ checkId: 'editor', boundary: 'event', result: judged }];
  });
  expect(trialReportSchema.parse(report)).toEqual(report);
});

test('replay preserves explicit unknown judge evidence and rejects invalid measured metadata', async () => {
  const { report } = await fixture(report => {
    report.evaluation.judgeCalls = [{ ...call, responseModel: null, responseRoute: null,
      outcome: 'generation-error', usage: null, failureKind: 'protocol' },
    // A recovered judgement stays recoverable-looking after replay: strip `retryOf` here
    // and a score from a second attempt reads exactly like one that answered first time.
    { ...call, outcome: 'completed', retryOf: 'actual-generation', retryCause: 'provider-error' }];
  });
  expect(trialReportSchema.parse(report).evaluation.judgeCalls).toEqual(report.evaluation.judgeCalls);
  for (const malformed of [
    { ...call, id: '' },
    { ...call, retryOf: '' },
    { ...call, retryCause: 'grant-vaporised' },
    { ...call, outcome: 'invented' },
    { ...call, usage: { ...usage, cacheWriteInputTokens: -1 } },
    { ...call, responseModel: 42 },
  ]) {
    expect(() => trialReportSchema.parse({ ...report,
      evaluation: { ...report.evaluation, judgeCalls: [malformed] } })).toThrow();
  }
});

/**
 * The closure cause has to survive being read back. This schema strips what it
 * does not declare, so an undeclared `stop.unconfirmed` would put an operator
 * back where they were before the vocabulary existed: a replayed report that
 * says a trial was unscorable and not which proof was missing.
 */
test('a replayed report keeps which closure proof failed', async () => {
  const { report } = await fixture();
  report.stop = { state: 'unknown', scope: 'native-handle', quiescence: 'unknown', remoteWork: 'unknown',
    reason: 'External input delivery budget exhausted', unconfirmed: 'native-stop-unacknowledged',
    detail: 'Native child closure unconfirmed (native-stop-unacknowledged); caller must stop the shared container' };
  expect(trialReportSchema.parse(JSON.parse(JSON.stringify(report))).stop).toMatchObject({ unconfirmed: 'native-stop-unacknowledged' });
  // Only the closed vocabulary parses; an invented cause is refused, not carried.
  expect(() => trialReportSchema.parse(JSON.parse(JSON.stringify({ ...report, stop: { ...report.stop, unconfirmed: 'made-up' } })))).toThrow();
});

/**
 * The same argument for the judge: a replayed report that says `error` and not
 * which judge refused, expired or answered unreadably is the anonymous failure
 * coming straight back through the schema that was meant to preserve it.
 */
test('a replayed report keeps why a judge errored', async () => {
  const { report } = await fixture();
  const failure = { cause: 'grant-refused' as const, judge: 'grounding', providerId: 'grok-broker-grant',
    requestedModel: 'grok-4.6', responseModel: null, responseRoute: null, kind: 'unavailable' as const };
  const stage = report.evaluation.stages[0]!;
  stage.checks.push({ id: 'grounding', status: 'error', finality: 'final', reason: 'Routed inference stopped (unavailable)',
    evidence: [], judgeFailure: failure });
  const parsed = trialReportSchema.parse(JSON.parse(JSON.stringify(report)));
  expect(parsed.evaluation.stages[0]!.checks.at(-1)!.judgeFailure).toEqual(failure);
  // Only the closed vocabulary parses; an invented cause is refused, not carried.
  stage.checks.at(-1)!.judgeFailure = { ...failure, cause: 'grant-vaporised' as never };
  expect(() => trialReportSchema.parse(JSON.parse(JSON.stringify(report)))).toThrow();
});


test('persisted replay retains full grading identity, coverage and call provenance', async () => {
  const digest = 'a'.repeat(64);
  const grading: GradeResult = { status: 'unknown', score: 0.2, coverage: 0.5,
    gates: [{ id: 'grounded', status: 'unknown' }],
    questions: [{ id: 'clear', score: 0.2, instances: 2, not_applicable: 0, escalated: 1, missing: 1 }],
    identity: { calibration: { expansion: [['clear', digest]], questions: { clear: digest }, promptTemplateVersion: 'v1', segmenter: 'icu-test',
      optionMapping: { clear: digest }, backendModel: 'local:tested', golden: digest, seed: 'seed', exclusions: [],
      escalation: digest, escalationTeacher: digest, uncalibrated: 'refuse' },
    calibrationDigest: digest, escalation: digest, teacherPolicy: digest, scoringPolicy: digest },
    backendBilling: 'local', judgeCalls: [call] };
  const { store, report, options } = await fixture(report => {
    const graded = { ...report.evaluation.checks.old!, grading, judgeCalls: [call] };
    report.evaluation.checks.old = graded;
    report.evaluation.stages[0]!.checks = [graded];
    report.evaluation.stages[0]!.gate = graded;
    report.turns[0]!.checks = [graded];
    report.live = [{ checkId: 'grader', boundary: 'artifact', result: graded }];
    report.decisiveFailure = graded;
  });
  const replayed = capturedTrial(await store.readReplay(options.runId, options.access)).report;
  expect(replayed).toEqual(report);
  expect(replayed.evaluation.checks.old!.grading).toEqual(grading);
  for (const invalid of [{ ...grading, score: 2 }, { ...grading, coverage: -1 },
    { ...grading, backendBilling: 'free' }, { ...grading, identity: { ...grading.identity, calibrationDigest: 'stale' } },
    { ...grading, questions: [{ ...grading.questions[0], missing: -1 }] },
    { ...grading, judgeCalls: [{ ...call, billing: 'invented' }] },
    { ...grading, judgeCalls: [{ ...call, wallMs: -1 }] }]) {
    expect(() => trialReportSchema.parse({ ...report, evaluation: { ...report.evaluation,
      checks: { old: { ...report.evaluation.checks.old, grading: invalid } } } })).toThrow();
  }
});

test('replay preserves typed tool refusal on persisted grading calls', async () => {
  const refused: JudgeCall = { ...call, outcome: 'refused', failureKind: 'protocol', failureDetail: 'tool-call' };
  const { report } = await fixture(report => { report.evaluation.judgeCalls = [refused]; });
  expect(trialReportSchema.parse(JSON.parse(JSON.stringify(report))).evaluation.judgeCalls).toEqual([refused]);
  expect(() => trialReportSchema.parse({ ...report, evaluation: { ...report.evaluation,
    judgeCalls: [{ ...refused, failureDetail: 'SECRET' }] } })).toThrow();
});

test.each(['measured', 'payment-error'] as const)('stored replay preserves atomic identities and request costs: %s', async mode => {
  const digest = 'a'.repeat(64);
  const backend = createTypeSafeDecision({ model: 'jev-1.0.0', env: { TYPESAFE_API_KEY: 'offline-key' },
    fetch: async () => mode === 'payment-error' ? new Response('', { status: 402 }) : Response.json({ model: 'jev-1.0.0', answers: { q: { type: 'noul', noul: 1 } },
      usage: { input_tokens: 500, output_tokens: 0 } }) });
  const receipts: import('../../contracts/grading.js').DecisionRequestReceipt[] = [];
  const scoring = backend.score([{ key: 'q', type: 'noul', optionLabels: ['true', 'false'], instructions: 'Covered?', projection: {} }], undefined, receipts);
  if (mode === 'payment-error') await expect(scoring).rejects.toThrow('payment failed');
  else await scoring;
  expect(receipts[0]!.requestId).toEqual(expect.any(String));
  const atomicGrading: import('../../graders/atomic/index.js').AtomicGradeResult = {
    schema: 'paideia.atomic-grade.v1', status: mode === 'payment-error' ? 'error' : 'unknown', score: mode === 'payment-error' ? null : 0, coverage: 0, criticalGate: 0, obligationCoverage: 0, quality: 0,
    identity: { definitionDigest: digest, templatesDigest: digest, outputDigest: digest, contextDigest: digest },
    checks: [], extraction: { receipts: [{ failure: 'malformed', response_text: 'raw protected extraction' }], judgeCalls: [call] },
    receipts,
    feedback: { failed_check_count: 1, omitted_failed_checks: 0, failed_checks: [{ template: 'support', unit: 'Observed span', probability: null }] }, judgeCalls: [call],
  };
  const { store, options, report } = await fixture(report => {
    const graded = { ...report.evaluation.checks.old!, atomicGrading };
    report.evaluation.checks.old = graded; report.evaluation.stages[0]!.checks = [graded];
    report.turns[0]!.checks = [graded]; report.live = [{ checkId: 'grader', boundary: 'artifact', result: graded }];
  });
  const replayed = capturedTrial(await store.readReplay(options.runId, options.access)).report;
  expect(replayed).toEqual(report);
  const costs = summarizeCosts([replayed], { subjectModel: 'unknown' });
  expect(costs.entries.filter(entry => entry.decisionReceipt).map(entry => entry.decisionReceipt)).toEqual(receipts);
  expect(costs.knownSubtotalUsd.low).toBeCloseTo(receipts[0]!.usd ?? 0);
  if (mode === 'payment-error') {
    expect(costs.entries.find(entry => entry.decisionReceipt)!.valuation.status).toBe('incomplete');
    expect(() => trialScore(replayed)).toThrow('unscorable atomic grading measurement');
  }
  const legacy = structuredClone(report);
  delete legacy.evaluation.checks.old!.atomicGrading!.receipts[0]!.requestId;
  expect(trialReportSchema.parse(legacy)).toEqual(legacy);
  for (const invalid of [{ ...atomicGrading, coverage: -1 }, { ...atomicGrading, identity: { ...atomicGrading.identity, outputDigest: 'changed' } },
    { ...atomicGrading, receipts: [{ ...atomicGrading.receipts[0], usd: -1 }] },
    { ...atomicGrading, receipts: [{ ...atomicGrading.receipts[0], requestId: '' }] }]) {
    expect(() => trialReportSchema.parse({ ...report, evaluation: { ...report.evaluation,
      checks: { old: { ...report.evaluation.checks.old, atomicGrading: invalid } } } })).toThrow();
  }
});

test('replay retains host durations and declared subject isolation without inventing them in legacy reports', async () => {
  const { report } = await fixture();
  report.durationMs = 123.5;
  report.subject = { adapterId: 'native', requestedModel: 'requested-alias', isolation: 'declared isolation' };
  expect(trialReportSchema.parse(report)).toMatchObject({ durationMs: 123.5, subject: report.subject });
  expect(() => trialReportSchema.parse({ ...report, durationMs: -1 })).toThrow();
  delete report.durationMs; delete report.subject;
  expect(trialReportSchema.parse(report).durationMs).toBeUndefined();
  expect(trialReportSchema.parse(report).subject).toBeUndefined();
});


test('replay retains valid evaluated manifests and rounds, rejecting altered identities or sealed attribution', async () => {
  const { report, runRoot } = await fixture();
  await writeFile(join(runRoot, 'instructions.md'), 'Keep the original policy.');
  const candidate = await snapshotCandidate({ sourceRoot: runRoot, resources: [{ id: 'instructions', sourcePath: 'instructions.md',
    destinations: [{ kind: 'instructions', path: 'AGENTS.md' }], edit: 'whole-file' }] });
  report.candidateId = candidate.id; report.candidate = candidate; report.round = 2;
  expect(trialReportSchema.parse(JSON.parse(JSON.stringify(report)))).toMatchObject({ candidate, round: 2 });
  expect(() => trialReportSchema.parse({ ...report, candidateId: 'other' })).toThrow('identity mismatch');
  expect(() => trialReportSchema.parse({ ...report, candidate: { ...candidate, id: 'corrupt' } })).toThrow('manifest');
  expect(() => trialReportSchema.parse({ ...report, phase: 'test' })).toThrow('search round');
  expect(() => trialReportSchema.parse({ ...report, round: -1 })).toThrow();
  expect(() => trialReportSchema.parse({ ...report, round: 0.5 })).toThrow();
});
