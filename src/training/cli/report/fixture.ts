import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateComponents, deriveCandidate, snapshotCandidate } from '../../candidates/index.js';
import { summarizeCosts, type TrainingReport, type TrialReport } from '../../experiments/index.js';
import type { GradeResult } from '../../graders/index.js';

/** Two distinct, identically priced requests; no live provider or invoice claim. */
export function recordedGrade(): GradeResult {
  const digest = 'a'.repeat(64);
  const receipt = { billing: 'api' as const, model: 'jev-1.13.0', endpoint: 'https://example.test',
    inputTokens: 500, outputTokens: 0, usd: 0.021, estimatedInputTokens: 1000, estimatedUsd: 0.2, latencyMs: 5, status: 200 };
  return { status: 'fail', score: 0, coverage: 1, gates: [{ id: 'factual-accuracy', status: 'fail' }], questions: [],
    backendBilling: 'api', judgeCalls: [], identity: { calibration: { expansion: [], questions: {},
      promptTemplateVersion: 'v1', segmenter: 'test', optionMapping: {}, backendModel: receipt.model, golden: digest,
      seed: 's', exclusions: [], escalation: digest, escalationTeacher: digest, uncalibrated: 'refuse' },
    calibrationDigest: digest, escalation: digest, teacherPolicy: digest, scoringPolicy: digest },
    decisionAccounting: { billing: 'api', requests: 2, inputTokens: 1000, outputTokens: 0, usd: 0.042,
      latencyMs: { p50: 5, p95: 5 }, receipts: [receipt, { ...receipt }] } };
}

/** Synthetic capture evidence for adjacent export tests, never a native fidelity claim. */
export async function reportFixture() {
  const root = await mkdtemp(join(tmpdir(), 'paideia-report-'));
  await mkdir(join(root, 'notes'));
  await writeFile(join(root, 'AGENTS.md'), 'Keep the contract.\n');
  await writeFile(join(root, 'notes', 'reference.md'), 'Locked reference.\n');
  const baseline = await snapshotCandidate({ sourceRoot: root, resources: [
    { id: 'instructions', sourcePath: 'AGENTS.md', destinations: [{ kind: 'instructions', path: 'AGENTS.md' }], edit: 'whole-file' },
    { id: 'reference', sourcePath: 'notes/reference.md', destinations: [{ kind: 'supporting-files', path: 'notes/reference.md' }], edit: 'locked' },
  ] });
  const components = candidateComponents(baseline);
  const seed = Object.fromEntries(components.map(value => [value.id, value.text]));
  const proposed = [seed, { ...seed, [components[0]!.id]: 'Keep the contract.\nVerify outputs.\n' },
    { ...seed, [components[0]!.id]: 'Keep the contract.\nCheck receipts.\n' }];
  const candidates = [baseline, ...proposed.slice(1).map(value => deriveCandidate(baseline, baseline, value))];
  const trial = (candidateId: string, phase: TrialReport['phase'], recordId: string, score: number): TrialReport => ({
    schema: 'paideia.trial.v1', id: `trial-${phase}-${recordId}-${candidates.findIndex(value => value.id === candidateId)}`,
    candidateId, phase, recordId, datasetDigest: 'dataset', planDigest: 'plan', paths: { root, workspace: root, control: root, runtimeHome: root },
    durationMs: 250, subject: { adapterId: 'test-fixture', requestedModel: 'test-model', isolation: 'synthetic fixture' },
    status: 'pass', execution: 'completed', hostWork: 'settled',
    stop: { state: 'acknowledged', quiescence: 'confirmed', remoteWork: 'unknown', scope: 'native-handle', reason: 'completed', detail: 'fixture' },
    snapshot: { trialId: 'fixture', recordId, closed: true, events: [], coverage: [], artifacts: {}, output: '', inputFiles: {}, context: {} },
    turns: [], live: [], evaluation: { status: 'pass', checks: {}, scores: {}, stages: [
      { id: 'quality', checks: [], gate: { status: 'pass', finality: 'final', reason: 'fixture', evidence: [] },
        score: { finality: 'final', lower: score, upper: score, assessedWeight: 1, missingWeight: 0 } },
    ] },
  });
  const trials = candidates.flatMap((candidate, index) => [trial(candidate.id, 'train', 'train-example', index / 2),
    trial(candidate.id, 'validation', 'validation-example', index / 2)]);
  trials.push(trial(baseline.id, 'test', 'test-a', 0.2), trial(baseline.id, 'test', 'test-b', 0.6),
    trial(candidates[1]!.id, 'test', 'test-a', 0.7), trial(candidates[1]!.id, 'test', 'test-b', 0.7));
  const report: TrainingReport = { schema: 'paideia.training.v1', id: 'completed', baseline, selected: candidates[1]!, durationMs: 1000,
    partitions: { train: ['train-example'], validation: ['validation-example'], test: ['test-a', 'test-b'] }, trials,
    heldOut: [], optimizer: { schema: 'paideia.dspy.v2', id: 'optimizer', kind: 'result', components: proposed[1]!,
      provenance: { optimizer: 'paideia.population', dspyVersion: '3.3.1', gepaVersion: '0.1.4', seed: 0,
        evaluations: 6, proposals: 2, selectedCandidateIndex: 1, generations: [], captures: [],
        candidates: proposed.map((value, index) => ({ components: value, parents: [index === 0 ? null : 0],
          validationScore: index / 2, discoveryEvaluations: index * 2 })),
        rounds: [{ round: 0, parents: [], kept: [0], variants: [] },
          { round: 1, parents: [0], kept: [1], variants: [{ slot: 0, parent: 0, strategy: 'refine', hypothesis: 'verify',
            targetedCriteria: [], behavioralChange: null, lexicalChange: null, status: 'accepted', rejectionReason: null, candidateIndex: 1, attempts: [] }] },
          { round: 2, parents: [1], kept: [1], variants: [{ slot: 0, parent: 1, strategy: 'rewrite', hypothesis: 'check',
            targetedCriteria: [], behavioralChange: null, lexicalChange: null, status: 'accepted', rejectionReason: null, candidateIndex: 2, attempts: [] }] }] } },
  };
  report.costs = summarizeCosts(trials, { subjectModel: 'test-model' });
  return { root, report };
}
