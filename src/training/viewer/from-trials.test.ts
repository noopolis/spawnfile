import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotCandidate } from '../src/candidates/index.js';
import type { RescoreReport } from '../src/experiments/replay/index.js';
import { trialDetails } from './cockpit/evidence.js';
import type { TrialReport } from '../src/experiments/index.js';
import type { DspyResult } from '../src/optimization/index.js';
import { summarizeCosts } from '../src/experiments/costs/index.js';
import { projectViewerData } from './projection.js';
import { projectTrials, projectTrainingReport } from './index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

export function reportFixture(id = 'trial'): TrialReport {
  const check = { status: 'pass' as const, finality: 'final' as const, reason: 'SECRET judge reason', score: 0.7, evidence: [{ kind: 'event' as const, id: 'event' }] };
  return { schema: 'paideia.trial.v1', id, phase: 'validation', candidateId: 'native-candidate', datasetDigest: 'dataset', planDigest: 'plan',
    recordId: 'case', paths: { root: '/private', workspace: '/private', control: '/private', runtimeHome: '/private' },
    status: 'pass', execution: 'completed', hostWork: 'settled', live: [],
    stop: { state: 'acknowledged', scope: 'process-group', quiescence: 'confirmed', remoteWork: 'unknown',
      reason: 'Fixture completed', detail: 'Local callback and process cleanup acknowledged' },
    snapshot: { trialId: id, recordId: 'case', closed: true, coverage: [], artifacts: {}, output: 'SECRET output', inputFiles: { hidden: 'SECRET input' },
      context: { hidden: 'SECRET label' }, events: [
        { id: 'event', source: 'native', seq: 1, type: 'output', timestamp: 'now', trialId: id, wakeId: 'wake', text: 'SECRET output' },
        { id: 'success', source: 'native', seq: 2, type: 'tool.complete', timestamp: 'now', trialId: id, wakeId: 'wake', tool: 'observed_tool', success: true, args: 'SECRET', result: 'SECRET' },
        { id: 'failed', source: 'native', seq: 3, type: 'tool.complete', timestamp: 'now', trialId: id, wakeId: 'wake', success: false },
      ] }, turns: [{ id: 'wake', checks: [], native: { status: 'completed', text: 'SECRET', coverage: [], usage: null } }],
    evaluation: { status: 'pass', checks: {}, scores: {}, stages: [{ id: 'stage', checks: [{ ...check, children: [check] }],
      gate: { ...check, id: 'gate' }, score: { finality: 'final', lower: 0.7, upper: 0.7, assessedWeight: 1, missingWeight: 0 } }] },
  };
}

async function baseline() {
  const root = await mkdtemp(join(tmpdir(), 'paideia-projection-')); roots.push(root);
  await writeFile(join(root, 'AGENTS.md'), 'SECRET source instructions');
  return snapshotCandidate({ sourceRoot: root, resources: [
    { id: 'instructions', sourcePath: 'AGENTS.md', destinations: [{ kind: 'instructions', path: 'AGENTS.md' }], edit: 'whole-file' },
  ] });
}

describe('stored native report projection', () => {
  it('exposes IDs, verdicts, supplied scores and observed event summaries without raw subject/judge text', async () => {
    const candidate = await baseline();
    const trial = reportFixture();
    const data = projectTrials({ id: 'view', title: 'Projection', phase: 'replay', status: 'complete', updatedAt: 'now',
      cases: [{ id: 'case', split: 'validation' }], baseline: candidate, trials: [trial] });
    expect(JSON.stringify(data)).not.toMatch(/SECRET|\/private/);
    expect(data.trials[0]!.score).toBe(0.7);
    expect(data.trials[0]!.events.map((event) => event.summary)).toEqual(['output', 'observed_tool succeeded', 'tool.complete failed']);
    expect(data.trials[0]!.checks[0]!.children[0]!.children[0]!.id).toBe('stage/0/0');
    trial.execution = 'failed'; trial.status = 'unknown'; delete trial.evaluation.stages[0]!.score;
    trial.evaluation.stages[0]!.gate.score = undefined;
    const unknown = projectTrials({ id: 'view', title: 'Projection', phase: 'replay', status: 'failed', updatedAt: 'now', cases: [], baseline: candidate, trials: [trial] });
    expect(unknown.trials[0]!.score).toBeNull(); expect(unknown.trials[0]!.checks[0]!.score).toBeNull();
  });

  it.each(['missing', 'unknown', 'host-incomplete'] as const)('shows no trial score when local cleanup is %s', async (cleanup) => {
    const candidate = await baseline();
    const trial = reportFixture();
    if (cleanup === 'missing') delete trial.stop;
    else if (cleanup === 'unknown') trial.stop = { ...trial.stop!, state: 'unknown', quiescence: 'unknown' };
    else trial.hostWork = 'incomplete';
    const data = projectTrials({ id: 'view', title: 'Projection', phase: 'replay', status: 'incomplete', updatedAt: 'now',
      cases: [{ id: 'case', split: 'validation' }], baseline: candidate, trials: [trial] });
    expect(trial.status).toBe('pass');
    expect(trial.evaluation.stages[0]!.score!.lower).toBe(0.7);
    expect(data.trials[0]!.score).toBeNull();
  });

  it('links GEPA lineage to recorded validation captures and keeps instance IDs unique for repeated native candidates', async () => {
    const candidate = await baseline();
    const trials = [reportFixture('baseline-trial'), reportFixture('proposal-trial')];
    const optimizer: DspyResult = { schema: 'paideia.dspy.v2', kind: 'result', id: 'opt', components: { editable: 'SECRET' },
      provenance: { optimizer: 'dspy.GEPA', dspyVersion: '3.3.1', gepaVersion: '0.1.4', seed: 0, evaluations: 2, proposals: 1,
        selectedCandidateIndex: 1, candidates: [
          { components: { editable: 'SECRET' }, parents: [null], validationScore: 0.7, discoveryEvaluations: 0 },
          { components: { editable: 'SECRET' }, parents: [0], validationScore: 0.8, discoveryEvaluations: 1 },
        ], captures: trials.map((trial) => ({ caseId: 'case', split: 'validation', captureId: trial.id })),
        generations: [{ model: 'observed-model', modelBasis: 'requested-assumption', usage: null }] } };
    const report = { schema: 'paideia.training.v1' as const, id: 'opt', baseline: candidate, selected: candidate,
      optimizer, partitions: { train: ['train'], validation: ['case'], test: ['sealed'] }, trials, heldOut: [{ candidateId: candidate.id, meanScore: 0.5, trialIds: ['a', 'b'],
        evaluationIds: ['a', 'b'], trialScores: [0, 1], standardError: 0.5 }],
      costs: summarizeCosts(trials, { subjectModel: 'gpt-5.5' }) };
    const data = projectTrainingReport(report, { maxMetricCalls: 6, maxProposals: 2 });
    expect(projectViewerData(data).heldOut).toEqual([{ candidateId: candidate.id, meanScore: 0.5, trialScores: [0, 1], standardError: 0.5 }]);
    expect(data.candidates.map((entry) => entry.id)).toEqual(['GEPA 0: native-candidate', 'GEPA 1: native-candidate']);
    expect(data.candidates.map((entry) => entry.nativeId)).toEqual(['native-candidate', 'native-candidate']);
    expect(data.candidates[1]!.parentIds).toEqual(['GEPA 0: native-candidate']);
    expect(data.optimizer).toMatchObject({ evaluations: 2, proposals: 1, selectedCandidateId: 'GEPA 1: native-candidate' });
    expect(data.usage.at(-1)).toMatchObject({ purpose: 'optimizer', model: 'observed-model', modelBasis: 'requested-assumption', route: null });
    expect(data.costs!.observed!.lines).toHaveLength(2);
    expect(data.costs!.observed!.lines[0]!.model).toBe('gpt-5.5');
    expect(projectTrainingReport(report).optimizer).toBeUndefined();
    expect(() => projectTrainingReport({ ...report, trials: [] })).toThrow('matching stored native validation');
  });
});

it('shows the latest rescore and weighted criteria on the original native capture', async () => {
  const candidate = await baseline(), trial = reportFixture(); trial.status = 'error';
  const gate = { status: 'pass' as const, finality: 'final' as const, evidence: [], reason: 'SECRET' };
  const score: RescoreReport = { schema: 'paideia.rescore.v1', id: 'rescore', runId: trial.id, scope: 'final-stages',
    notReevaluated: ['live', 'per-turn'], original: { evaluationId: 'old', digest: 'old', candidateId: trial.candidateId,
      datasetDigest: 'old', planDigest: 'old', recordId: trial.recordId, phase: trial.phase, status: trial.status },
    criteria: { datasetId: 'dataset', datasetDigest: 'digest', sharedPlanDigest: 'plan', stages: [], registryVersions: {},
      sidecarDigests: {}, inferenceRoutes: { judges: {}, embeddings: {} } },
    execution: trial.execution, hostWork: trial.hostWork, stop: trial.stop, coverage: [], status: 'pass',
    evaluation: { status: 'pass', checks: {}, scores: {}, stages: [{ id: 'quality', gate, weights: { prose: 3, facts: 1, pending: 1 },
      checks: [{ ...gate, id: 'prose', score: 0.5 }, { ...gate, id: 'facts' }, { ...gate, id: 'pending', status: 'unknown' },
        { ...gate, id: 'grounding', status: 'error', reason: 'SECRET prompt and article text',
          judgeFailure: { cause: 'grant-refused' as const, judge: 'grounding', providerId: 'grok-broker-grant',
            requestedModel: 'grok-4.6', responseModel: null, responseRoute: null, kind: 'unavailable' as const } }],
      score: { finality: 'final', lower: 0.8, upper: 0.8, assessedWeight: 5, missingWeight: 0 } }] } };
  const original = structuredClone(trial);
  const data = projectTrials({ id: 'view', title: 'Rescore', phase: 'train', status: 'running', updatedAt: 'now',
    cases: [{ id: trial.recordId, split: trial.phase }], baseline: candidate, trials: [trial],
    rescores: [{ ...score, id: 'earlier', status: 'fail' }, score] });
  expect(data.trials).toHaveLength(1); expect(data.usage).toHaveLength(1);
  expect(data.trials[0]).toMatchObject({ id: trial.id, score: 0.8, status: 'pass (rescored; original error; completed; host work settled)' });
  expect(data.trials[0]!.checks[0]!.children).toMatchObject([
    { id: 'prose', weight: 3, weightedContribution: 0.3 }, { id: 'facts', weight: 1, weightedContribution: 0.2 },
    { id: 'pending', weight: 1, weightedContribution: null },
    { id: 'grounding', status: 'error', judgeFailure: { cause: 'grant-refused', judge: 'grounding' } }, { status: 'pass' },
  ]);
  // The cause reaches the published page; the reason it came with still does not.
  expect(data.trials[0]!.checks[0]!.children[3]).not.toHaveProperty('reason');
  expect(data.trials[0]!.events).toHaveLength(trial.snapshot.events.length);
  const html = trialDetails(data);
  expect(html).toContain('weight 3'); expect(html).toContain('contribution 0.3'); expect(html).not.toMatch(/SECRET|NaN/);
  expect(html).toContain('Judge failure: grant-refused');
  expect(html).toContain('judge grounding'); expect(html).toContain('requested grok-4.6'); expect(html).toContain('answered unknown');
  expect(trial).toEqual(original);
});
