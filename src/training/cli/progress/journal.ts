import { randomUUID } from 'node:crypto';
import { summarizeCosts, type ModelPrice, type OptimizerGeneration, type TrainingCostPlan, type TrialReport } from '../../experiments/index.js';
import type { ExperimentStore } from '../../storage/index.js';
import type { CliIO } from '../types.js';

export interface ProgressOptions {
  id: string;
  datasetId: string;
  planDigest: string;
  candidateId: string;
  model: string;
  prices: readonly ModelPrice[];
  store: ExperimentStore;
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
  const generations = new Map<number, OptimizerGeneration>();
  const costs = () => summarizeCosts([...trials.values()], { subjectModel: options.model,
    prices: options.prices, optimizerGenerations: [...generations.values()] });
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
    async observe(event: { type: string; payload: unknown }) {
      const payload = event.payload as Record<string, unknown>;
      if (event.type === 'trial.finished') {
        const report = event.payload as TrialReport;
        trials.set(report.id, report);
        await write(event.type, { trialId: report.id, phase: report.phase, candidateId: report.candidateId,
          status: report.status, execution: report.execution });
      } else if (event.type === 'trial.queued') {
        await write(event.type, { phase: payload.phase, candidateId: payload.candidateId });
      } else if (event.type === 'optimizer.generation.started') {
        generations.set(payload.attempt as number, { model: null, usage: null, outcome: 'pending' });
        await write(event.type, { attempt: payload.attempt });
      } else if (event.type === 'optimizer.generation.completed') {
        const generation = payload as unknown as OptimizerGeneration & { attempt: number };
        generations.set(generation.attempt, { model: generation.model, usage: generation.usage,
          modelBasis: generation.modelBasis, route: generation.route, attempts: generation.attempts, outcome: 'completed' });
        await write(event.type, { attempt: generation.attempt, model: generation.model,
          modelBasis: generation.modelBasis, route: generation.route });
      } else if (event.type === 'optimizer.generation.failed') {
        const generation = payload as unknown as Partial<OptimizerGeneration>;
        generations.set(payload.attempt as number, { model: null, usage: null, attempts: generation.attempts, outcome: 'generation-error' });
        await write(event.type, { attempt: payload.attempt, outcome: 'generation-error' });
      } else if (event.type === 'training.started') {
        await write(event.type, { budget: payload.budget });
      } else if (event.type === 'selection.frozen') {
        await write(event.type, { candidateId: payload.selectedId });
      } else if (event.type === 'training.completed' || event.type === 'evaluation.completed') {
        await write(event.type, { status: 'completed' });
      }
    },
    async failed(error: unknown) {
      for (const [id, generation] of generations) {
        if (generation.outcome === 'pending') generations.set(id, { ...generation, outcome: 'interrupted; usage unknown' });
      }
      const diagnostic = await options.store.putBlob(runId, String(error).slice(0, 16384), 'evaluator');
      const diagnosticId = randomUUID();
      await options.store.appendEvent(runId, { id: diagnosticId,
        payload: { type: 'experiment.diagnostic', diagnostic } }, 'evaluator');
      await write('experiment.failed', { status: 'failed', error: 'Experiment failed; protected diagnostic is available to the operator.', diagnosticId });
      return { diagnosticId };
    },
  };
}
