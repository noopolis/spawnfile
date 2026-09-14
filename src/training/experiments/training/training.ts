import { randomUUID } from 'node:crypto';
import type { CandidateManifest } from '../../candidates/index.js';
import { candidateComponents, deriveCandidate, validateCandidate } from '../../candidates/index.js';
import { validateDatasetSplit } from '../../cases/index.js';
import type { ResolvedDataset } from '../../contracts/dataset.js';
import type { InferenceProvider } from '../../contracts/execution.js';
import { InferenceFailure } from '../../inference/index.js';
import { createDspyGeneration, runDspyOptimization, type DspyOptimizationOptions, type DspyResult } from '../../optimization/index.js';
import type { TrialReport } from '../trials/index.js';
import { partitionTraining } from './partition.js';
import { runStoredTrial, type StoredTrialOptions } from '../trials/index.js';
import { trialScore } from './scoring.js';
import { freezeCriteria } from './criteria.js';
import { trainingFeedback } from './feedback.js';
import type { CostReport, TrainingCostPlan } from '../costs/index.js';

export interface TrainingOptions {
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
  seed?: number;
  signal?: AbortSignal;
  onProgress?: (event: { type: string; payload: unknown }) => Promise<void>;
}
export interface TrainingReport {
  schema: 'paideia.training.v1';
  id: string;
  baseline: CandidateManifest;
  selected: CandidateManifest;
  optimizer: DspyResult;
  partitions: { train: string[]; validation: string[]; test: string[] };
  trials: TrialReport[];
  heldOut: { candidateId: string; meanScore: number; trialIds: string[] }[];
  /** Optional host reporting, never optimizer feedback or a subscription invoice. */
  costs?: CostReport;
  costPlan?: TrainingCostPlan;
}
export async function trainAgent(options: TrainingOptions): Promise<TrainingReport> {
  validateCandidate(options.baseline);
  const partition = options.validation ? { train: options.train, validation: options.validation }
    : partitionTraining(options.train, options.validationGroups);
  validateDatasetSplit(partition.train, options.test, partition.validation);
  const criteria = new Map<ResolvedDataset, StoredTrialOptions['evaluation']>();
  for (const dataset of [partition.train, partition.validation, options.test]) {
    criteria.set(dataset, await freezeCriteria(dataset, options.native.evaluation, options.native.registry));
  }
  const baselineComponents = Object.fromEntries(candidateComponents(options.baseline).map(component => [component.id, component.text]));
  if (!Object.keys(baselineComponents).length) throw new Error('No declared editable components');
  const trials: TrialReport[] = [];
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
  const trial = async (dataset: ResolvedDataset, caseId: string, phase: 'train' | 'validation' | 'test', candidate: CandidateManifest, signal?: AbortSignal) => {
    const record = dataset.records.find(record => record.id === caseId);
    if (!record) throw new Error(`Case ${caseId} is not in ${phase}`);
    await options.onProgress?.({ type: 'trial.queued', payload: { caseId, phase, candidateId: candidate.id } });
    const report = await runStoredTrial({ ...options.native, id: randomUUID(), phase, record: structuredClone(record), candidate,
      datasetId: dataset.id, datasetDigest: dataset.sourceDigest, planDigest: dataset.sharedPlanDigest,
      signal: signal ?? options.signal, evaluation: criteria.get(dataset)! });
    trials.push(report);
    await options.onProgress?.({ type: 'trial.finished', payload: report });
    return report;
  };
  await options.onProgress?.({ type: 'training.started', payload: { id: options.id, baselineId: options.baseline.id,
    train: partition.train.records.map(record => record.id), validation: partition.validation.records.map(record => record.id), budget: options.budget } });
  const optimizer = await runDspyOptimization({ id: options.id, components: baselineComponents,
    trainCaseIds: partition.train.records.map(record => record.id), validationCaseIds: partition.validation.records.map(record => record.id),
    bridge: options.bridge, budget: options.budget, seed: options.seed, signal: options.signal,
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
    evaluate: async (request, signal) => {
      const dataset = request.split === 'train' ? partition.train : partition.validation;
      const report = await trial(dataset, request.caseId, request.split, candidateFor(request.components), signal);
      const record = dataset.records.find(record => record.id === request.caseId)!;
      return { score: trialScore(report), captureId: report.id, ...trainingFeedback(record, report) };
    } });
  const selected = candidateFor(optimizer.components);
  // Freeze selection BEFORE the sealed test can execute or become feedback.
  const frozen = [...new Map([options.baseline, selected].map(candidate => [candidate.id, candidate])).values()];
  await options.onProgress?.({ type: 'selection.frozen', payload: { selectedId: selected.id, baselineId: options.baseline.id, optimizer } });
  const heldOut: TrainingReport['heldOut'] = [];
  for (const candidate of frozen) {
    const reports: TrialReport[] = [];
    for (const record of options.test.records) reports.push(await trial(options.test, record.id, 'test', candidate));
    heldOut.push({ candidateId: candidate.id, meanScore: reports.reduce((sum, report) => sum + trialScore(report), 0) / reports.length,
      trialIds: reports.map(report => report.id) });
  }
  const report: TrainingReport = { schema: 'paideia.training.v1', id: options.id, baseline: options.baseline, selected, optimizer,
    partitions: { train: partition.train.records.map(record => record.id), validation: partition.validation.records.map(record => record.id),
      test: options.test.records.map(record => record.id) }, trials, heldOut };
  await options.onProgress?.({ type: 'training.completed', payload: report });
  return report;
}
