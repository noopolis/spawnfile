import { randomUUID } from 'node:crypto';
import { subjectStartupDiagnostic, summarizeCosts, type ModelPrice, type OptimizerGeneration, type TrainingCostPlan, type TrialReport } from '../../experiments/index.js';
import { blobContentPath, type ExperimentStore } from '../../storage/index.js';
import type { RescoreReport } from '../../experiments/replay/index.js';
import type { CliIO } from '../types.js';
import { createGenerationTracker } from './generations.js';

export interface ProgressOptions {
  id: string;
  datasetId: string;
  planDigest: string;
  candidateId: string;
  model: string;
  prices: readonly ModelPrice[];
  store: ExperimentStore;
  /** The run output root the store was opened on; only used to name a durable artifact. */
  storeRoot?: string;
  io: CliIO;
  costPlan?: TrainingCostPlan;
}

/** Status only: held-out content and optimizer text never enter this projection. */
export async function createProgressJournal(options: ProgressOptions) {
  const runId = `progress-${options.id}`;
  await options.store.createRun({ schema: 'paideia.run.v1', id: runId, datasetId: options.datasetId,
    datasetRole: 'train', candidateId: options.candidateId, planDigest: options.planDigest,
    metadata: { costPlan: options.costPlan } });
  const trials = new Map<string, TrialReport>();
  const rescores = new Map<string, RescoreReport>();
  const generations = createGenerationTracker();
  const costs = () => summarizeCosts([...trials.values()], { subjectModel: options.model,
    prices: options.prices, rescores: [...rescores.values()], optimizerGenerations: generations.snapshot() });
  const summary = () => {
    const cost = costs();
    return { apiEquivalentUsd: cost.apiEquivalentUsd, knownSubtotalUsd: cost.knownSubtotalUsd,
      completeness: cost.completeness, usageCoverage: cost.usageCoverage, groups: cost.groups };
  };
  const write = async (type: string, fields: Record<string, unknown>) => {
    const cost = costs();
    const payload = { type, ...fields, cost: { apiEquivalentUsd: cost.apiEquivalentUsd,
      knownSubtotalUsd: cost.knownSubtotalUsd, completeness: cost.completeness, usageCoverage: cost.usageCoverage } };
    await options.store.appendEvent(runId, { id: randomUUID(), payload }, 'public');
    options.io.stdout(`${JSON.stringify({ progressRunId: runId, ...payload })}\n`);
  };
  await write('experiment.started', { model: options.model, estimatedApiEquivalentUsd: options.costPlan?.apiEquivalentUsd });
  return {
    runId,
    costs,
    summary,
    reports: () => [...trials.values()],
    rescores: () => [...rescores.values()],
    async observe(event: { type: string; payload: unknown }) {
      const payload = event.payload as Record<string, unknown>;
      generations.observe(event);
      if (event.type === 'trial.finished' || event.type === 'trial.restored') {
        const report = event.payload as TrialReport;
        trials.set(report.id, report);
        await write(event.type, { trialId: report.id, phase: report.phase, candidateId: report.candidateId,
          status: report.status, execution: report.execution });
      } else if (event.type === 'trial.rescored' || event.type === 'trial.rescore.restored') {
        const report = event.payload as RescoreReport;
        rescores.set(report.id, report);
        await write(event.type, { trialId: report.runId, evaluationId: report.id,
          phase: report.original.phase, status: report.status });
      } else if (event.type === 'trial.queued') {
        await write(event.type, { phase: payload.phase, candidateId: payload.candidateId });
      } else if (event.type === 'optimizer.generation.started') {
        await write(event.type, { attempt: payload.attempt });
      } else if (event.type === 'optimizer.generation.completed') {
        const generation = payload as unknown as OptimizerGeneration & { attempt: number };
        await write(event.type, { attempt: generation.attempt, model: generation.model,
          modelBasis: generation.modelBasis, route: generation.route });
      } else if (event.type === 'optimizer.generation.failed') {
        await write(event.type, { attempt: payload.attempt, outcome: 'generation-error' });
      } else if (event.type === 'optimizer.restored') {
        await write(event.type, { attempts: generations.attempts() });
      } else if (event.type === 'training.started' || event.type === 'comparison.started') {
        await write(event.type, { budget: payload.budget });
      } else if (event.type === 'selection.frozen' || event.type === 'comparison.frozen') {
        await write(event.type, { candidateId: payload.selectedId ?? payload.candidateId });
      } else if (event.type === 'training.completed' || event.type === 'comparison.completed' || event.type === 'evaluation.completed') {
        await write(event.type, { status: 'completed' });
      }
    },
    async failed(error: unknown) {
      generations.interrupt();
      const diagnostic = await options.store.putBlob(runId, String(error).slice(0, 16384), 'evaluator');
      const diagnosticId = randomUUID();
      await options.store.appendEvent(runId, { id: diagnosticId,
        payload: { type: 'experiment.diagnostic', diagnostic } }, 'evaluator');
      // Adapter-published, already-redacted accounts of subjects that never became ready. The raw error string
      // above stays protected; only these reach the progress stream, and only their stated reason.
      const startup = [subjectStartupDiagnostic(error), ...[...trials.values()].map(report => report.diagnostic)]
        .filter((row): row is NonNullable<TrialReport['diagnostic']> => row !== undefined);
      const reason = startup.at(0)?.reason ?? startup.at(-1)?.reason;
      const published = startup.length
        ? await options.store.putBlob(runId, JSON.stringify({ schema: 'paideia.startup-diagnostics.v1', runId, diagnostics: startup }), 'evaluator')
        : undefined;
      await write('experiment.failed', { status: 'failed',
        error: reason ? `Experiment failed: ${reason}` : 'Experiment failed; protected diagnostic is available to the operator.',
        diagnosticId,
        ...(published && options.storeRoot ? { startupDiagnostics: blobContentPath(options.storeRoot, published) } : {}),
        // An operator-only capture is the last account of a failure whose bytes could not be published.
        ...(startup.find(row => row.operatorCapture)?.operatorCapture ? { operatorCapture: startup.find(row => row.operatorCapture)!.operatorCapture } : {}) });
      return { diagnosticId };
    },
  };
}
