import { afterEach, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import type { RescoreReport } from '../../experiments/index.js';
import { recordedGrade, reportFixture } from './fixture.js';
import { summarizeTraining } from './summary.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => { const value = await reportFixture(); roots.push(value.root); return value; };

it('retains nested semantic gate verdicts and original live measurements', async () => {
  const { report } = await fixture(); const trial = report.trials[0]!;
  const graded = { status: 'unknown' as const, finality: 'final' as const, reason: 'Grader writing', evidence: [], grading: recordedGrade() };
  graded.grading.gates = [{ id: 'passed', status: 'pass' }, { id: 'missing-facts', status: 'unknown' }, { id: 'judge-error', status: 'error' }];
  trial.evaluation.checks.nested = { ...graded, grading: undefined, children: [{ ...graded, id: 'writing' }] };
  trial.live = [{ checkId: 'writing', boundary: 'close', result: graded }];
  const summary = summarizeTraining(report);
  expect(summary.failureSummary).toContainEqual({ check: 'check/nested/writing/grading/gate/missing-facts', status: 'unknown', trials: 1 });
  expect(summary.failureSummary).toContainEqual({ check: 'live/writing/0/grading/gate/judge-error', status: 'error', trials: 1 });
  expect(summary.failingChecks.some(value => value.check.endsWith('/passed'))).toBe(false);
  delete report.costs;
  const receiptsOnly = summarizeTraining(report);
  expect(receiptsOnly.requests).toMatchObject({ judge: 4, optimizer: null, subject: null });
  expect(receiptsOnly.costs!.knownSubtotalUsd.low).toBe(0.084);
  expect(receiptsOnly.costs!.apiEquivalentUsd).toBeNull();
});

it('retains every candidate and all split/example measurements without reselecting from test', async () => {
  const { report } = await fixture();
  const summary = summarizeTraining(report);
  expect(summary.candidates).toHaveLength(3);
  expect(summary.selectedCandidateId).toBe(report.selected.id);
  expect(summary.candidates[2]!.splits.validation.meanScore).toBe(1);
  expect(summary.candidates[1]!.rounds).toEqual([1, 2]);
  expect(summary.candidates[0]!.rounds).toEqual([0, 1]);
  expect(summary.roundScores.every(round => round.candidates[0]!.label === 'baseline')).toBe(true);
  expect(summary.roundScores[2]!.candidates.map(value => value.label)).toEqual(['baseline', 'candidate-1', 'candidate-2']);
  expect(summary.candidates[0]!.splits.train.meanScore).toBe(0);
  expect(summary.candidates[1]!.splits.test.meanScore).toBe(0.7);
  expect(summary.candidates[2]!.splits.test).toMatchObject({ complete: false, meanScore: null, observedMean: null });
  expect(summary.heldOut.meanDelta).toBeCloseTo(0.3);
  expect(summary.heldOut.standardDeviation).toBeCloseTo(Math.sqrt(0.08));
  expect(summary.heldOut.standardError).toBeCloseTo(0.2);
  expect(summary.heldOut.uncertainty).toContain('no confidence interval');
  expect(summary.durationMs).toBe(1000);
  expect(summary.candidates[0]!.splits.train.examples[0]!.measurements[0]).toMatchObject({
    durationMs: 250, fidelity: { historical: 'unverified', declaredIsolation: 'synthetic fixture', measurement: 'native-trial' } });
  expect(summary.requests).toMatchObject({ judge: 0, optimizer: 0, subject: null });
});

it('does not inflate incomplete splits or uncertainty from missing trials, failed execution, or legacy metadata', async () => {
  const { report } = await fixture();
  report.trials = report.trials.filter(trial => trial.recordId !== 'test-b' || trial.candidateId === report.baseline.id);
  const failed = report.trials.find(trial => trial.phase === 'train')!;
  failed.execution = 'failed'; delete failed.durationMs; delete failed.subject;
  delete report.costs; delete report.durationMs; delete report.optimizer.provenance.rounds;
  const summary = summarizeTraining(report);
  expect(summary.candidates[0]!.splits.train).toMatchObject({ meanScore: null, complete: false });
  expect(summary.candidates[0]!.splits.train.examples[0]!.measurements[0]).toMatchObject({
    score: null, scoreUnavailable: expect.stringContaining('infrastructure'), durationMs: null, fidelity: { declaredIsolation: null } });
  expect(summary.heldOut).toMatchObject({ complete: false, meanDelta: null, pairedExamples: 1, standardDeviation: null, standardError: null });
  expect(summary.requests).toMatchObject({ judge: null, optimizer: null, subject: null });
  expect(summary.costs).toBeNull(); expect(summary.durationMs).toBeNull();
});

it('labels a single or absent holdout as insufficient instead of inventing precision', async () => {
  const { report } = await fixture();
  report.partitions.test = ['test-a']; report.trials = report.trials.filter(trial => trial.recordId !== 'test-b');
  expect(summarizeTraining(report).heldOut).toMatchObject({ complete: true, pairedExamples: 1, standardError: null,
    uncertainty: expect.stringContaining('unknown') });
  report.partitions.test = []; report.trials = report.trials.filter(trial => trial.phase !== 'test');
  expect(summarizeTraining(report).heldOut).toMatchObject({ complete: false, meanDelta: null });
});

it('uses the latest rescore once, preserving original live/turn failures and detailed check reasons', async () => {
  const { report } = await fixture();
  const trial = report.trials[0]!;
  const check = { status: 'fail' as const, finality: 'final' as const, reason: 'Receipt missing', evidence: [], grading: recordedGrade(),
    children: [{ id: 'receipt', status: 'unknown' as const, finality: 'final' as const, reason: 'Not observed', evidence: [] }] };
  trial.turns = [{ id: 'wake', checks: [check], native: { status: 'completed', text: '', usage: null, coverage: [] } }];
  trial.live = [{ checkId: 'receipt', boundary: 'close', result: check }]; trial.decisiveFailure = check;
  const rescore: RescoreReport = { schema: 'paideia.rescore.v1', id: 'rescored', runId: trial.id,
    scope: 'final-stages', notReevaluated: ['live', 'per-turn'],
    original: { evaluationId: 'original', digest: 'digest', candidateId: trial.candidateId, datasetDigest: 'dataset',
      planDigest: 'plan', recordId: trial.recordId, phase: trial.phase, status: trial.status },
    criteria: { datasetId: 'dataset', datasetDigest: 'dataset', sharedPlanDigest: 'plan', stages: [], registryVersions: {},
      sidecarDigests: {}, inferenceRoutes: { judges: {}, embeddings: {} } },
    execution: trial.execution, hostWork: trial.hostWork, stop: trial.stop, coverage: [], status: 'fail', error: 'Quality failed',
    evaluation: { ...trial.evaluation, status: 'fail', checks: { quality: check }, stages: [{ id: 'quality', checks: [check], gate: check }] } };
  report.rescores = [{ ...rescore, id: 'earlier' }, rescore];
  const summary = summarizeTraining(report);
  expect(summary.candidates[0]!.splits.train.examples[0]!.measurements).toHaveLength(1);
  expect(summary.candidates[0]!.splits.train.examples[0]!.measurements[0]).toMatchObject({ score: 0, evaluationId: 'rescored',
    fidelity: { measurement: 'rescore' } });
  expect(summary.failingChecks).toEqual(expect.arrayContaining([expect.objectContaining({ check: 'check/quality/receipt', status: 'unknown' }),
    expect.objectContaining({ check: 'trial-outcome', reason: 'Quality failed' })]));
  expect(summary.failureSummary.every(value => value.trials === 1)).toBe(true);
  expect(summary.failingChecks).toContainEqual(expect.objectContaining({ evaluationId: 'rescored',
    check: 'check/quality/grading/gate/factual-accuracy', status: 'fail' }));
  const failures = summary.failingChecks.filter(value => value.trialId === trial.id);
  for (const prefix of ['turn/wake/0', 'live/receipt/0', 'decisiveFailure']) {
    expect(failures.filter(value => value.check === prefix || value.check.startsWith(`${prefix}/`)))
      .toEqual([
        expect.objectContaining({ check: prefix, evaluationId: trial.id, status: 'fail' }),
        expect.objectContaining({ check: `${prefix}/receipt`, evaluationId: trial.id, status: 'unknown' }),
        expect.objectContaining({ check: `${prefix}/grading/gate/factual-accuracy`, evaluationId: trial.id, status: 'fail' }),
      ]);
  }
  expect(failures.filter(value => value.check.startsWith('check/') || value.check.startsWith('stage/') || value.check === 'trial-outcome'))
    .toEqual(Array.from({ length: 10 }, () => expect.objectContaining({ evaluationId: 'rescored' })));
});

it.each(['unknown-candidate', 'duplicate-trial', 'wrong-split', 'missing-selection'] as const)('refuses silently incomplete provenance: %s', async mode => {
  const { report } = await fixture();
  if (mode === 'unknown-candidate') report.trials[0]!.candidateId = 'unknown';
  if (mode === 'duplicate-trial') report.trials.push(report.trials[0]!);
  if (mode === 'wrong-split') report.trials[0]!.recordId = 'outside';
  if (mode === 'missing-selection') report.optimizer.provenance.candidates.splice(1, 1);
  expect(() => summarizeTraining(report)).toThrow();
});


it('uses original round measurements, separating prior captures, later rescores and sealed test scores', async () => {
  const { report } = await fixture();
  const first = report.trials[0]!; first.round = 0;
  first.evaluation.stages[0]!.score!.lower = first.evaluation.stages[0]!.score!.upper = 0.2;
  const second = structuredClone(first); second.id = 'later-round'; second.round = 1;
  second.evaluation.stages[0]!.score!.lower = second.evaluation.stages[0]!.score!.upper = 0.8;
  report.trials.push(second);
  report.trials[1]!.round = 0;
  // A later final-stage rescore replaces the final split score, never past search evidence.
  report.rescores = [{ id: 'later-rescore', runId: first.id, execution: first.execution, hostWork: first.hostWork,
    stop: first.stop, status: 'pass', evaluation: second.evaluation } as RescoreReport];
  const summary = summarizeTraining(report);
  const seed = summary.roundScores[0]!.candidates[0]!;
  const next = summary.roundScores[1]!.candidates[0]!;
  expect(seed).toMatchObject({ train: 0.2, validation: 0, test: null });
  expect(next).toMatchObject({ train: 0.8, validation: null, test: null });
  expect(seed.availableThroughRound.train.meanScore).toBe(0.2);
  expect(next.availableThroughRound.train.meanScore).toBe(0.5);
  expect(next.availableThroughRound.validation.meanScore).toBe(0);
  expect(seed.splits.train.examples[0]!.measurements).toMatchObject([{ round: 0, evaluationId: first.id, score: 0.2 }]);
  expect(summary.candidates[0]!.splits.train.meanScore).toBe(0.8);
  expect(summary.unattributedSearchTrialIds).not.toContain(first.id);
  expect(summary.unattributedSearchTrialIds).toContain(report.trials[2]!.id);
  // GEPA has no population membership, but its actual callback round IDs still form rows.
  delete report.optimizer.provenance.rounds;
  expect(summarizeTraining(report).roundScores.map(value => value.round)).toEqual([0, 1]);
});

it('refuses mismatched evaluated manifests and sealed round attribution', async () => {
  const { report } = await fixture();
  report.trials[0]!.candidate = report.selected;
  expect(() => summarizeTraining(report)).toThrow('identity mismatch');
  report.trials[0]!.candidate = report.baseline;
  report.trials.find(trial => trial.phase === 'test')!.round = 2;
  expect(() => summarizeTraining(report)).toThrow('search round');
});
