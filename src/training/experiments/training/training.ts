import { testRepeatCount } from '../../contracts/training-config.js';
import { MutationQueue } from '../../platform/mutations/index.js';
import { loadTrialSlots } from '../concurrency/index.js';
import type { TrialSlot } from '../../contracts/trial-slot.js';
import { repairMeasurement } from '../repair/index.js';
import { recoverMeasurement, recoverStoredReport } from './recovery.js';
import type { RescoreReport } from '../replay/index.js';
import { TrainingCheckpoint } from './checkpoint.js';
import { randomUUID } from 'node:crypto';
import type { CandidateManifest } from '../../candidates/index.js';
import { candidateComponents, deriveCandidate, validateCandidate } from '../../candidates/index.js';
import { validateDatasetSplit } from '../../cases/index.js';
import type { ResolvedDataset } from '../../contracts/dataset.js';
import type { InferenceProvider } from '../../contracts/execution.js';
import { InferenceFailure } from '../../inference/index.js';
import { createDspyGeneration, runDspyOptimization, readDspyCheckpointEvidence, type DspyOptimizationOptions, type DspyResult } from '../../optimization/index.js';
import type { TrialReport } from '../trials/index.js';
import { resolveTrainingPartitions } from './partition.js';
import { runStoredTrial, type StoredTrialOptions } from '../trials/index.js';
import { trialScore } from './scoring.js';
import { freezeCriteria } from './criteria.js';
import { trainingFeedback } from './feedback.js';
import { evaluateHeldOut, type HeldOutScore } from './held-out.js';
import type { CostReport, TrainingCostPlan } from '../costs/index.js';

export interface TrainingOptions {
  testRepeats?: number;
  concurrency?: number;
  slotsFile?: string;
  slots?: readonly TrialSlot[];
  id: string;
  baseline: CandidateManifest;
  train: ResolvedDataset;
  validation?: ResolvedDataset;
  validationGroups?: readonly string[];
  test: ResolvedDataset;
  native: Omit<StoredTrialOptions, 'id' | 'phase' | 'record' | 'candidate' | 'datasetDigest' | 'datasetId' | 'planDigest'>;
  inference: { provider: InferenceProvider; model: string };
  bridge: DspyOptimizationOptions['bridge'];
  budget: DspyOptimizationOptions['budget'];
  proposal?: DspyOptimizationOptions['proposal'];
  search?: DspyOptimizationOptions['search'];
  checkpoint?: { directory: string; resume: boolean; identity: string; maxRecoveryAttempts?: number;
    fork?: NonNullable<DspyOptimizationOptions['checkpoint']>['fork'] & { trainingDigest: string; trainingIdentity: string; receiptDigest: string } };
  seed?: number;
  signal?: AbortSignal;
  onProgress?: (event: { type: string; payload: unknown }) => Promise<void>;
}
export interface TrainingReport {
  schema: 'paideia.training.v1';
  id: string;
  baseline: CandidateManifest;
  selected: CandidateManifest;
  /** Elapsed host time for this invocation, including restoration and sealed testing. */
  durationMs?: number;
  optimizer: DspyResult;
  partitions: { train: string[]; validation: string[]; test: string[] };
  trials: TrialReport[];
  heldOut: HeldOutScore[];
  /** Separate measurements over an original native capture, never additional trials. */
  rescores?: RescoreReport[];
  /** Optional host reporting, never optimizer feedback or a subscription invoice. */
  costs?: CostReport;
  costPlan?: TrainingCostPlan;
  lineage?: { kind: 'measurement-repair'; parentExperimentId: string; parentExecutionIdentity: string;
    executionIdentity: string; receiptDigest: string; inheritedTrialIds: string[] };
}
export async function trainAgent(options: TrainingOptions): Promise<TrainingReport> {
  const started = performance.now();
  const testRepeats = testRepeatCount(options.testRepeats);
  if ('maxRunRequests' in options) throw new Error('Run-wide Grok request admission is not implemented; maxRunRequests cannot be enforced');
  const { concurrency, pool, slots } = await loadTrialSlots(options);
  const progress = options.onProgress;
  const mutations = new MutationQueue();
  options = { ...options, concurrency, slots,
    onProgress: progress ? event => mutations.run(() => progress(event)) : undefined };
  validateCandidate(options.baseline);
  const partition = resolveTrainingPartitions(options.train, options.validation, options.validationGroups);
  validateDatasetSplit(partition.train, options.test, partition.validation);
  const criteria = new Map<ResolvedDataset, StoredTrialOptions['evaluation']>();
  for (const [phase, dataset] of [['train', partition.train], ['validation', partition.validation], ['test', options.test]] as const) {
    criteria.set(dataset, await freezeCriteria(dataset, options.native.evaluation, options.native.registry,
      `${phase}:${dataset.id}:${dataset.sourceDigest}:${dataset.sharedPlanDigest}`));
  }
  const components = candidateComponents(options.baseline);
  const baselineComponents = Object.fromEntries(components.map(component => [component.id, component.text]));
  const editScope = options.search ? Object.fromEntries(components.map(component => [component.id, component.heading ?? 'whole-file' as const])) : undefined;
  if (!Object.keys(baselineComponents).length) throw new Error('No declared editable components');
  const checkpoint = await TrainingCheckpoint.open(options, [partition.train, partition.validation, options.test]);
  const trials: TrialReport[] = [...checkpoint?.reports ?? []];
  const rescores = [...checkpoint?.rescores ?? []];
  const inheritedTrialIds = checkpoint?.inheritedTrialIds ?? [];
  for (const report of trials) await options.onProgress?.({ type: 'trial.restored', payload: report });
  for (const report of rescores) await options.onProgress?.({ type: 'trial.rescore.restored', payload: report });
  const measured = (report: TrialReport) => rescores.findLast(rescore => rescore.runId === report.id) ?? report;
  let generations = 0;
  const generate = createDspyGeneration(options.inference.provider, options.inference.model);
  const candidates = new Map<string, CandidateManifest>();
  const key = (components: Readonly<Record<string, string>>) => JSON.stringify(Object.keys(components).sort().map(name => [name, components[name]]));
  candidates.set(key(baselineComponents), options.baseline);
  const candidateFor = (components: Readonly<Record<string, string>>) => {
    if (Object.keys(components).length !== Object.keys(baselineComponents).length || Object.keys(baselineComponents).some(id => !Object.hasOwn(components, id))) {
      throw new Error('Optimizer changed the editable component set');
    }
    const identity = key(components);
    let candidate = candidates.get(identity);
    if (!candidate) { candidate = deriveCandidate(options.baseline, options.baseline, components); candidates.set(identity, candidate); }
    return candidate;
  };
  const trial = async (dataset: ResolvedDataset, caseId: string, phase: 'train' | 'validation' | 'test', candidate: CandidateManifest, signal?: AbortSignal, callbackId?: string, round?: number) => {
    const record = dataset.records.find(record => record.id === caseId);
    if (!record) throw new Error(`Case ${caseId} is not in ${phase}`);
    const key = callbackId ?? `test:${candidate.id}:${caseId}`;
    const entry = await checkpoint?.begin(key);
    if (entry?.restored) {
      const report = await recoverStoredReport(options, entry.id, phase, candidate.id, entry.report);
      if (!entry.report) { await checkpoint!.complete(key, report); entry.report = report; trials.push(report); }
    }
    if (entry?.report) {
      const recovery = { options, dataset, report: entry.report, previous: entry.rescores?.at(-1),
        evaluation: criteria.get(dataset)!, signal: signal ?? options.signal,
        pendingRescoreId: entry.pendingRescoreId,
        reserve: () => checkpoint!.reserveRecovery(options.checkpoint?.maxRecoveryAttempts ?? 2, key) };
      const rescore = options.checkpoint?.fork && checkpoint!.inheritedTrialIds.includes(entry.report.id)
        ? await repairMeasurement(recovery, options.checkpoint.fork.receiptDigest)
        : await recoverMeasurement(recovery);
      if (rescore && rescore !== entry.rescores?.at(-1)) {
        await checkpoint!.rescore(key, rescore); rescores.push(rescore);
        await options.onProgress?.({ type: 'trial.rescored', payload: rescore });
      }
      await options.onProgress?.({ type: 'trial.reused', payload: { id: entry.report.id, caseId, phase, candidateId: candidate.id } });
      return entry.report;
    }
    const id = entry?.id ?? randomUUID();
    await options.onProgress?.({ type: 'trial.queued', payload: { caseId, phase, candidateId: candidate.id } });
    const lease = await pool?.acquire(signal ?? options.signal);
    let confirmed = false;
    let report: TrialReport;
    try {
    report = await runStoredTrial({ ...options.native, slot: lease?.slot, id, phase, round, record: structuredClone(record), candidate,
      datasetId: dataset.id, datasetDigest: dataset.sourceDigest, planDigest: dataset.sharedPlanDigest,
      signal: signal ?? options.signal, evaluation: criteria.get(dataset)!,
      protectedPaths: [...options.native.protectedPaths ?? [], ...options.checkpoint ? [options.checkpoint.directory] : []],
      observeEvent: async event => {
        await options.native.observeEvent?.(event);
        await options.onProgress?.({ type: 'trial.progress', payload: { trialId: id, caseId, phase, candidateId: candidate.id, event } });
      } });
    confirmed = report.hostWork === 'settled' && report.stop?.state === 'acknowledged' && report.stop.quiescence === 'confirmed';
    await checkpoint?.complete(key, report);
    } finally { lease?.release(confirmed); }
    trials.push(report);
    await options.onProgress?.({ type: 'trial.finished', payload: report });
    return report;
  };
  await options.onProgress?.({ type: 'training.started', payload: { id: options.id, baselineId: options.baseline.id,
    train: partition.train.records.map(record => record.id), validation: partition.validation.records.map(record => record.id), budget: options.budget } });
  if (checkpoint?.optimizer && options.checkpoint) {
    const restored = await readDspyCheckpointEvidence({ id: options.id, components: baselineComponents,
      trainCaseIds: partition.train.records.map(record => record.id), validationCaseIds: partition.validation.records.map(record => record.id),
      concurrency, budget: options.budget, seed: options.seed, proposal: options.proposal, search: options.search, editScope, checkpoint: options.checkpoint });
    await options.onProgress?.({ type: 'optimizer.restored', payload: restored });
  }
  const optimizer = checkpoint?.optimizer ?? await runDspyOptimization({ id: options.id, components: baselineComponents,
    trainCaseIds: partition.train.records.map(record => record.id), validationCaseIds: partition.validation.records.map(record => record.id),
    concurrency, bridge: options.bridge, checkpoint: options.checkpoint, proposal: options.proposal, search: options.search, editScope,
    onRestore: async evidence => { await options.onProgress?.({ type: 'optimizer.restored', payload: evidence }); }, budget: options.budget, seed: options.seed, signal: options.signal,
    validateComponents: components => { candidateFor(components); },
    generate: async (request, signal) => {
      const attempt = ++generations;
      await options.onProgress?.({ type: 'optimizer.generation.started', payload: { attempt } });
      let response;
      try { response = await generate(request, signal); }
      catch (error) {
        await options.onProgress?.({ type: 'optimizer.generation.failed', payload: { attempt,
          requestedModel: options.inference.model, model: null, route: null, usage: null, outcome: 'generation-error',
          ...(error instanceof InferenceFailure ? { attempts: error.attempts } : {}) } });
        throw error;
      }
      await options.onProgress?.({ type: 'optimizer.generation.completed', payload: { attempt, model: response.model,
        modelBasis: response.modelBasis, route: response.route, usage: response.usage,
        ...(response.attempts ? { attempts: response.attempts } : {}) } });
      return response;
    },
    evaluate: async (request, signal, callbackId) => {
      const dataset = request.split === 'train' ? partition.train : partition.validation;
      const report = await trial(dataset, request.caseId, request.split, candidateFor(request.components), signal, callbackId, request.round);
      const record = dataset.records.find(record => record.id === request.caseId)!;
      return { score: trialScore(measured(report)), captureId: report.id, ...trainingFeedback(record, report, measured(report).evaluation) };
    } });
  await checkpoint?.freeze(optimizer);
  const selected = candidateFor(optimizer.components);
  // Freeze selection BEFORE the sealed test can execute or become feedback.
  const frozen = [...new Map([options.baseline, selected].map(candidate => [candidate.id, candidate])).values()];
  await options.onProgress?.({ type: 'selection.frozen', payload: { selectedId: selected.id, baselineId: options.baseline.id, optimizer } });
  const heldOut = await evaluateHeldOut({ candidates: frozen, caseIds: options.test.records.map(record => record.id), concurrency, testRepeats,
    trial: (candidate, caseId, repeat) => trial(options.test, caseId, 'test', candidate, undefined,
      repeat === 0 ? undefined : `test-repeat:${JSON.stringify([candidate.id, caseId, repeat])}`),
    measurement: report => ({ id: measured(report).id, score: trialScore(measured(report)) }) });
  const report: TrainingReport = { schema: 'paideia.training.v1', id: options.id, durationMs: performance.now() - started, baseline: options.baseline, selected, optimizer,
    partitions: { train: partition.train.records.map(record => record.id), validation: partition.validation.records.map(record => record.id),
      test: options.test.records.map(record => record.id) }, trials, heldOut, ...(rescores.length ? { rescores } : {}),
    ...(options.checkpoint?.fork ? { lineage: { kind: 'measurement-repair' as const,
      parentExperimentId: options.checkpoint.fork.id, parentExecutionIdentity: options.checkpoint.fork.identity,
      executionIdentity: options.checkpoint.identity, receiptDigest: options.checkpoint.fork.receiptDigest, inheritedTrialIds } } : {}) };
  await options.onProgress?.({ type: 'training.completed', payload: report });
  return report;
}
