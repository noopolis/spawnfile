import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { parseDatasetYaml, resolveDataset } from '../../cases/index.js';
import { candidateComponents, snapshotCandidate } from '../../candidates/index.js';
import { createEvaluationRegistry } from '../../evaluation/index.js';
import type { AtomicGradeResult } from '../../graders/atomic/index.js';
import { openExperimentStore } from '../../storage/index.js';
import * as optimization from '../../optimization/index.js';
import type { TrialReport } from '../trials/index.js';
import { TrainingCheckpoint, trainingDigest } from './checkpoint.js';
import { trainAgent, type TrainingOptions } from './training.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const digest = 'a'.repeat(64);
function grading(id: string, size: number): AtomicGradeResult {
  return { schema: 'paideia.atomic-grade.v1', status: 'pass', score: 1, coverage: 1, criticalGate: 1,
    obligationCoverage: 1, quality: 1, identity: { definitionDigest: digest, templatesDigest: digest, outputDigest: digest, contextDigest: digest },
    checks: Array.from({ length: 378 }, (_, index) => ({
      check: { id: `${id}-${index}`, template_id: 'support', unit_id: `unit-${index}`, type: 'noul',
        instructions: 'Is this supported?', criteria: {}, options: ['true', 'false'], expected: ['true'],
        projection: { source: 'x'.repeat(Math.ceil(size / 378)) }, digest, status: 'ready', reasons: [] },
      occurrence: `${index}`, unit: 'Observed text', kind: 'claim', dimension: 'accuracy', severity: 'major', probability: 1,
    })),
    extraction: { receipts: [], judgeCalls: [] }, receipts: [], judgeCalls: [],
    feedback: { failed_check_count: 0, omitted_failed_checks: 0, failed_checks: [] } };
}
function trial(id: string, phase: TrialReport['phase'], candidateId: string, size: number): TrialReport {
  const check = { id: 'writing', status: 'pass' as const, finality: 'final' as const, score: 1,
    reason: 'All checks passed', evidence: [], atomicGrading: grading(id, size) };
  return { schema: 'paideia.trial.v1', id, phase, candidateId, recordId: phase, datasetDigest: digest, planDigest: digest,
    paths: { root: '/fixture', workspace: '/fixture/workspace', control: '/fixture/control', runtimeHome: '/fixture/runtime' },
    status: 'pass', execution: 'completed', hostWork: 'settled',
    stop: { state: 'acknowledged', scope: 'native-handle', quiescence: 'confirmed', remoteWork: 'unknown', reason: 'completed', detail: 'fixture' },
    snapshot: { trialId: id, recordId: phase, closed: true, events: [], coverage: [], output: 'Finished', inputFiles: {}, context: {}, artifacts: {} },
    turns: [], live: [], evaluation: { status: 'pass', checks: { writing: check }, scores: {},
      stages: [{ id: 'quality', checks: [structuredClone(check)], gate: { status: 'pass', finality: 'final', reason: 'Passed', evidence: [] },
        score: { finality: 'final', lower: 1, upper: 1, assessedWeight: 1, missingWeight: 0 } }] } };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'checkpoint-payload-')); roots.push(root);
  await writeFile(join(root, 'AGENTS.md'), 'Follow the task.');
  const baseline = await snapshotCandidate({ sourceRoot: root, resources: [{ id: 'instructions', sourcePath: 'AGENTS.md',
    destinations: [{ kind: 'instructions', path: 'AGENTS.md' }], edit: 'whole-file' }] });
  const store = await openExperimentStore(root);
  const dataset = (id: string) => resolveDataset(parseDatasetYaml(`schema: paideia.dataset.v1\nid: ${id}\nchecks: [{id: writing, eval: contains-any, input: output.text, values: [Finished]}]\nrecords: [{id: ${id}, group: ${id}, input: {prompt: Task ${id}}}]\n`));
  const options: TrainingOptions = { id: 'experiment', concurrency: 1, baseline, train: dataset('train'), validation: dataset('validation'), test: dataset('test'),
    native: { store, storeRoot: root, root, model: 'fixture', timeoutMs: 1000,
      registry: createEvaluationRegistry(), evaluation: { judges: {}, embeddings: {}, readText: async () => '' },
      adapter: { id: 'fixture', capabilities: { toolTrace: 'none', liveObservations: false, cancellation: 'native-handle',
        multiTurn: false, resources: ['instructions'], isolation: 'fixture', readIsolation: 'declared-paths', protectedPaths: true },
      async start() { throw new Error('Settled native work must not repeat'); } } },
    inference: { model: 'fixture', provider: { id: 'fixture', capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
      async generate() { throw new Error('Frozen optimizer must not generate'); } } },
    bridge: { command: 'unused', cwd: root, timeoutMs: 1000 }, budget: { maxMetricCalls: 100, maxProposals: 1 },
    checkpoint: { directory: join(root, 'checkpoint'), identity: 'fixture', resume: false } };
  const createRun = async (report: TrialReport) => store.createRun({ schema: 'paideia.run.v1', id: report.id, datasetId: report.phase,
    datasetRole: report.phase, candidateId: baseline.id, planDigest: digest, recordId: report.recordId });
  return { root, options, store, createRun };
}

it('keeps 38 large duplicated trial grades out of the checkpoint and restores them exactly', async () => {
  const { root, options, createRun } = await fixture();
  const checkpoint = (await TrainingCheckpoint.open(options, []))!;
  let inlineBytes = 0;
  for (let index = 0; index < 38; index++) {
    const report = trial(`trial-${index}`, 'train', options.baseline.id, 1024 * 1024);
    inlineBytes += Buffer.byteLength(JSON.stringify(report));
    await createRun(report);
    await checkpoint.complete(`callback-${index}`, report);
  }
  expect(inlineBytes).toBeGreaterThan(67_108_864);
  const size = (await stat(join(options.checkpoint!.directory, 'training.json'))).size;
  expect(size).toBeLessThan(256 * 1024);
  expect(await readdir(join(root, 'blobs'))).toHaveLength(38);
  const reopened = (await TrainingCheckpoint.open({ ...options, checkpoint: { ...options.checkpoint!, resume: true } }, []))!;
  expect(reopened.reports).toEqual(checkpoint.reports);
}, 60000);

it('loads a completed legacy inline checkpoint, resumes to a training report and rewrites compactly', async () => {
  const { options, store, createRun } = await fixture();
  const datasets = [options.train, options.validation!, options.test];
  const checkpoint = (await TrainingCheckpoint.open(options, datasets))!;
  const reports = ['train', 'validation', 'test'].map(phase => trial(`trial-${phase}`, phase as TrialReport['phase'], options.baseline.id, 32768));
  for (const report of reports) {
    await createRun(report);
    await store.appendEvaluation(report.id, { id: 'original', report });
    await checkpoint.complete(report.phase === 'test' ? `test:${options.baseline.id}:test` : report.phase, report);
  }
  const optimizer: optimization.DspyResult = { schema: 'paideia.dspy.v2', kind: 'result', id: options.id,
    components: Object.fromEntries(candidateComponents(options.baseline).map(component => [component.id, component.text])),
    provenance: { optimizer: 'dspy.GEPA', dspyVersion: '3.3.1', gepaVersion: '0.1.4', seed: 0, evaluations: 2, proposals: 0,
      selectedCandidateIndex: 0, generations: [], captures: [], candidates: [] } };
  await checkpoint.freeze(optimizer);
  const path = join(options.checkpoint!.directory, 'training.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  // Reconstruct the old wire format, including duplicated inline grading detail.
  for (const entry of Object.values(saved.state.entries) as { id: string; report: TrialReport }[]) entry.report = reports.find(report => report.id === entry.id)!;
  saved.digest = trainingDigest(saved.state);
  await writeFile(path, JSON.stringify(saved));
  const legacySize = (await stat(path)).size;
  const restored = vi.spyOn(optimization, 'readDspyCheckpointEvidence').mockResolvedValue({ generations: [], failedAttempts: [], reservations: [] });
  const result = await trainAgent({ ...options, checkpoint: { ...options.checkpoint!, resume: true } });
  expect(restored).toHaveBeenCalledOnce();
  expect(result.trials).toEqual(reports);
  expect(result.heldOut).toMatchObject([{ meanScore: 1, trialIds: ['trial-test'] }]);
  expect((await stat(path)).size).toBeLessThan(legacySize / 10);
});

it.each(['missing', 'tampered'] as const)('refuses checkpoint resume with %s grading blobs', async mode => {
  const { root, options, createRun } = await fixture();
  const checkpoint = (await TrainingCheckpoint.open(options, []))!;
  const report = trial('trial', 'train', options.baseline.id, 100);
  await createRun(report); await checkpoint.complete('callback', report);
  const path = join(root, 'blobs', (await readdir(join(root, 'blobs')))[0]!);
  if (mode === 'missing') await rm(path);
  else await writeFile(path, (await readFile(path, 'utf8')).replace('"probability":1', '"probability":0'));
  await expect(TrainingCheckpoint.open({ ...options, checkpoint: { ...options.checkpoint!, resume: true } }, []))
    .rejects.toThrow(mode === 'missing' ? /ENOENT/ : /corrupt/);
});

it('retains the checkpoint size bound for oversized non-grading data and rolls back', async () => {
  const { options } = await fixture();
  const checkpoint = (await TrainingCheckpoint.open(options, []))!;
  const report = trial('huge', 'train', options.baseline.id, 0);
  report.evaluation.checks = {};
  report.evaluation.stages = [];
  report.snapshot.output = 'x'.repeat(67_108_864);
  await expect(checkpoint.complete('oversized', report)).rejects.toThrow('Training checkpoint exceeds 64 MiB');
  expect(checkpoint.reports).toEqual([]);
  const saved = JSON.parse(await readFile(join(options.checkpoint!.directory, 'training.json'), 'utf8'));
  expect(saved.state.entries).toEqual({});
});
