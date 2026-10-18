import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { assertOriginalPolicy, validateCandidate, type CandidateManifest } from '../candidates/index.js';
import type { TrialReport, TrainingReport } from '../experiments/index.js';
import { summarizeCosts, type CostReport, type ModelPrice, type TrainingCostPlan } from '../experiments/costs/index.js';
import type { DspyResult } from '../optimization/index.js';
import type { RescoreReport } from '../experiments/replay/index.js';
import { hydrateEvaluationJson, openExperimentStore, type ExperimentStore } from '../storage/index.js';
import { projectComparisonReport, projectTrainingReport, projectTrials, startViewer, type ViewerData } from '../../viewer/index.js';
import type { CliIO } from './types.js';
import { readCliText } from './datasets.js';
import { loadFailureView, createActivityTracker, createGenerationTracker } from './progress/index.js';

const id = z.string().min(1);
const reference = z.object({ runId: id, id, digest: id, size: z.number().int().nonnegative() }).strict();
const indexSchema = z.object({ schema: z.literal('paideia.invocation.v1'), command: z.enum(['evaluate', 'train']),
  outcome: z.literal('failed').optional(),
  summaryRunId: id, phase: z.enum(['train', 'test']), candidateId: id, trialIds: z.array(id),
  report: reference, candidate: reference,
  trainingExport: z.object({ directory: id, markdown: id, json: id }).strict().optional() }).strict();
const budgetSchema = z.object({ maxMetricCalls: z.number().int().nonnegative(), maxProposals: z.number().int().nonnegative() });

export async function loadInvocationViewer(root: string): Promise<() => Promise<ViewerData>> {
  // Resolve the explicit existing index before opening the store; an absent view never creates an output directory.
  const index = indexSchema.parse(JSON.parse(readCliText(join(root, 'invocation.json'), 2_000_000)));
  if (index.phase !== (index.command === 'train' && index.outcome !== 'failed' ? 'test' : 'train')
      || index.report.runId !== index.summaryRunId || index.candidate.runId !== index.summaryRunId) throw new Error('Invocation index references inconsistent phases or summaries');
  const store = await openExperimentStore(root);
  const access = { audience: 'operator' as const, phase: 'replay' as const,
    frozenCandidateIds: [index.candidateId], releaseTestResults: index.phase === 'test' };
  return async () => {
    const replay = await store.readReplay(index.summaryRunId, access);
    if (replay.manifest.candidateId !== index.candidateId || replay.manifest.datasetRole !== index.phase) throw new Error('Invocation index does not match its stored manifest');
    const candidate = JSON.parse((await store.readBlob(index.candidate, access)).toString()) as CandidateManifest;
    validateCandidate(candidate);
    if (candidate.id !== index.candidateId) throw new Error('Stored invocation candidate does not match its identity');
    const report = await hydrateEvaluationJson(store, JSON.parse((await store.readBlob(index.report, access)).toString()), access);
    if (index.outcome === 'failed') return loadFailureView(report, index, store);
    if (index.command === 'train') {
      if (report.schema === 'paideia.comparison.v1') {
        if (report.id !== index.summaryRunId || report.candidate.id !== candidate.id) throw new Error('Stored comparison does not match its invocation');
        assertOriginalPolicy(report.baseline, report.candidate);
        return projectComparisonReport(report);
      }
      if (report.schema !== 'paideia.training.v1' || report.id !== index.summaryRunId || report.selected.id !== candidate.id) throw new Error('Stored training report does not match its invocation');
      const metadata = replay.manifest.metadata as { optimizerBudget?: unknown } | undefined;
      const budget = metadata?.optimizerBudget === undefined ? undefined : budgetSchema.parse(metadata.optimizerBudget);
      return projectTrainingReport(report as TrainingReport, budget);
    }
    if (report.schema !== 'paideia.cli-evaluation.v1' || report.candidateId !== candidate.id) throw new Error('Stored evaluation report does not match its invocation');
    const trials = report.trials as TrialReport[];
    return projectTrials({ id: index.summaryRunId, title: 'Completed evaluation experiment', phase: 'replay',
      status: replay.completeness, updatedAt: 'Recorded completion', baseline: candidate, trials,
      costs: report.costs as CostReport | undefined, costPlan: report.costPlan as TrainingCostPlan | undefined,
      cases: trials.map((trial) => ({ id: trial.recordId, split: trial.phase })) });
  };
}

export async function viewInvocation(root: string, port: number, io: CliIO, signal: AbortSignal): Promise<void> {
  const load = await loadInvocationViewer(root);
  await load(); // Validate the saved invocation before announcing a server.
  signal.throwIfAborted();
  const server = await startViewer({ load, port });
  io.stdout(`${JSON.stringify({ viewer: server.url, mode: 'stored replay' })}\n`);
  try {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
  } finally { await server.close(); }
}

export async function startLiveViewer(options: {
  bindHost?: '127.0.0.1' | '0.0.0.0';
  port: number; io: CliIO; store: ExperimentStore; id: string; datasetId: string; planDigest: string;
  baseline: CandidateManifest; cases: ViewerData['cases']; testCases: ViewerData['cases'];
  comparison?: { candidate: CandidateManifest; name: string };
  budget?: { maxMetricCalls: number; maxProposals: number };
  scoring?: TrainingReport['scoring'];
  costs?: { subjectModel: string; prices?: readonly ModelPrice[]; costPlan?: TrainingCostPlan };
}) {
  const runId = `viewer-${options.id}`;
  await options.store.createRun({ schema: 'paideia.run.v1', id: runId, datasetId: options.datasetId,
    datasetRole: 'train', candidateId: options.baseline.id, planDigest: options.planDigest });
  let frozen = false, unavailable = false;
  let optimizer: DspyResult | undefined;
  let status = 'starting';
  let lastPersisted: ViewerData | undefined;
  let proposalAttempts = 0;
  const generations = createGenerationTracker();
  const trials: TrialReport[] = [];
  const rescores: RescoreReport[] = [];
  const sealedTrials = new Map<string, TrialReport>();
  const sealedRescores = new Map<string, RescoreReport>();
  const activity = createActivityTracker();
  let cases = options.cases;
  const publish = async () => {
    try {
      const data = projectTrials({ id: options.id, title: options.comparison ? `Authored comparison: ${options.comparison.name}` : 'Live native experiment', phase: frozen ? 'final-test' : 'train',
        status, updatedAt: new Date().toISOString(), baseline: options.baseline, comparison: options.comparison, cases,
        trials: status === 'failed' ? trials.filter(trial => trial.phase !== 'test') : trials, optimizer, budget: options.budget, scoring: options.scoring,
        rescores: status === 'failed' ? rescores.filter(score=>score.original.phase!=='test') : rescores,
        costs: options.costs === undefined ? undefined : summarizeCosts([...new Map([...trials, ...sealedTrials.values()].map(trial => [trial.id, trial])).values()], { ...options.costs,
          rescores: [...new Map([...rescores, ...sealedRescores.values()].map(score => [score.id, score])).values()], optimizerGenerations: generations.snapshot() }),
        costPlan: options.costs?.costPlan });
      if (!options.comparison && optimizer === undefined && options.budget !== undefined) data.optimizer = { name: 'dspy.GEPA',
        status: 'Observed progress; evaluation count includes completed trial reports',
        evaluations: trials.filter((trial) => trial.phase !== 'test').length, proposals: proposalAttempts, ...options.budget };
      data.activity = status === 'failed' ? undefined : activity.snapshot();
      data.usage = [...data.usage.filter((entry) => entry.purpose !== 'optimizer'), ...generations.snapshot().map(generation =>
        ({ purpose: 'optimizer' as const, model: generation.model, modelBasis: generation.modelBasis,
          route: generation.route ?? null, usage: generation.usage }))];
      if (status === 'failed') {
        data.usage = [];
        if (data.optimizer) data.optimizer.status = 'failed';
      }
      await options.store.appendEvent(runId, { id: randomUUID(), payload: data }, 'public');
      lastPersisted = data;
      unavailable = false;
    } catch {
      unavailable = true;
      options.io.stderr('Viewer snapshot unavailable; native evidence capture continues.\n');
    }
  };
  await publish();
  const server = await startViewer({ port: options.port, bindHost: options.bindHost, load: async () => {
    if (unavailable) throw new Error('Viewer snapshot unavailable');
    const replay = await options.store.readReplay(runId, { audience: 'viewer', phase: 'training' });
    return replay.events.at(-1)!.payload as ViewerData;
  } });
  options.io.stdout(`${JSON.stringify({ viewer: server.url, progressRunId: runId })}\n`);
  return {
    close: () => server.close(lastPersisted),
    async observe(event: { type: string; payload: unknown }) {
      if (status === 'failed') return;
      const generationEvent = generations.observe(event);
      proposalAttempts = generations.attempts();
      if (event.type === 'trial.progress') {
        const payload = event.payload as Parameters<typeof activity.observe>[0];
        if (payload.phase === 'test' && !frozen) return;
        activity.observe(payload);
      } else if (event.type === 'trial.rescored' || event.type === 'trial.rescore.restored') {
        const score=event.payload as RescoreReport;
        if(score.original.phase === 'test' && !frozen) { sealedRescores.set(score.id, score); await publish(); return; }
        if(!rescores.some(row=>row.id===score.id)) rescores.push(score);
      } else if (event.type === 'trial.finished' || event.type === 'trial.restored') {
        const report = event.payload as TrialReport;
        if (report.phase === 'test' && !frozen) { sealedTrials.set(report.id, report); await publish(); return; }
        if(!trials.some(row=>row.id===report.id)) trials.push(report); status = 'running';
      } else if (event.type === 'training.started' || event.type === 'comparison.started') {
        const payload = event.payload as { train: string[]; validation: string[] };
        cases = [...payload.train.map((id) => ({ id, split: 'train' as const })),
          ...payload.validation.map((id) => ({ id, split: 'validation' as const }))];
        status = options.comparison ? 'comparing frozen arms' : 'optimizing';
      } else if (event.type === 'selection.frozen' || event.type === 'comparison.frozen') {
        frozen = true;
        if (!options.comparison) optimizer = (event.payload as { optimizer: DspyResult }).optimizer;
        for (const report of sealedTrials.values()) if (!trials.some(trial => trial.id === report.id)) trials.push(report);
        for (const report of sealedRescores.values()) if (!rescores.some(score => score.id === report.id)) rescores.push(report);
        sealedTrials.clear(); sealedRescores.clear();
        cases = [...cases, ...options.testCases]; status = options.comparison ? 'testing frozen arms' : 'testing frozen selection';
      } else if (event.type === 'optimizer.generation.started') {
        status = 'reflecting';
      } else if (generationEvent) {
        status = 'running';
      } else if (event.type === 'experiment.failed') {
        status = 'failed'; frozen = false; optimizer = undefined;
        cases = cases.filter(record => record.split !== 'test');
        generations.interrupt();
      } else if (event.type === 'training.completed' || event.type === 'comparison.completed' || event.type === 'evaluation.completed') status = 'completed';
      else return;
      await publish();
    },
  };
}
