import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { validateCandidate, type CandidateManifest } from '../candidates/index.js';
import type { TrialReport, TrainingReport } from '../experiments/index.js';
import type { DspyResult } from '../optimization/index.js';
import { openExperimentStore, type ExperimentStore } from '../storage/index.js';
import { projectTrainingReport, projectTrials, startViewer, type ViewerData } from '../../viewer/index.js';
import type { CliIO } from './types.js';
import { readCliText } from './datasets.js';

const id = z.string().min(1);
const reference = z.object({ runId: id, id, digest: id, size: z.number().int().nonnegative() }).strict();
const indexSchema = z.object({ schema: z.literal('paideia.invocation.v1'), command: z.enum(['evaluate', 'train']),
  summaryRunId: id, phase: z.enum(['train', 'test']), candidateId: id, trialIds: z.array(id),
  report: reference, candidate: reference }).strict();
const budgetSchema = z.object({ maxMetricCalls: z.number().int().nonnegative(), maxProposals: z.number().int().nonnegative() });

export async function loadInvocationViewer(root: string): Promise<() => Promise<ViewerData>> {
  // Resolve the explicit existing index before opening the store; an absent view never creates an output directory.
  const index = indexSchema.parse(JSON.parse(readCliText(join(root, 'invocation.json'), 2_000_000)));
  if (index.phase !== (index.command === 'train' ? 'test' : 'train')
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
    const report = JSON.parse((await store.readBlob(index.report, access)).toString());
    if (index.command === 'train') {
      if (report.schema !== 'paideia.training.v1' || report.id !== index.summaryRunId || report.selected.id !== candidate.id) throw new Error('Stored training report does not match its invocation');
      const metadata = replay.manifest.metadata as { optimizerBudget?: unknown } | undefined;
      const budget = metadata?.optimizerBudget === undefined ? undefined : budgetSchema.parse(metadata.optimizerBudget);
      return projectTrainingReport(report as TrainingReport, budget);
    }
    if (report.schema !== 'paideia.cli-evaluation.v1' || report.candidateId !== candidate.id) throw new Error('Stored evaluation report does not match its invocation');
    const trials = report.trials as TrialReport[];
    return projectTrials({ id: index.summaryRunId, title: 'Completed evaluation experiment', phase: 'replay',
      status: replay.completeness, updatedAt: 'Recorded completion', baseline: candidate, trials,
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
  port: number; io: CliIO; store: ExperimentStore; id: string; datasetId: string; planDigest: string;
  baseline: CandidateManifest; cases: ViewerData['cases']; testCases: ViewerData['cases'];
  budget?: { maxMetricCalls: number; maxProposals: number };
}) {
  const runId = `viewer-${options.id}`;
  await options.store.createRun({ schema: 'paideia.run.v1', id: runId, datasetId: options.datasetId,
    datasetRole: 'train', candidateId: options.baseline.id, planDigest: options.planDigest });
  let frozen = false, unavailable = false;
  let optimizer: DspyResult | undefined;
  let status = 'starting';
  let proposalAttempts = 0;
  const generations: ViewerData['usage'] = [];
  const trials: TrialReport[] = [];
  let cases = options.cases;
  const publish = async () => {
    try {
      const data = projectTrials({ id: options.id, title: 'Live native experiment', phase: frozen ? 'final-test' : 'train',
        status, updatedAt: new Date().toISOString(), baseline: options.baseline, cases, trials, optimizer, budget: options.budget });
      if (optimizer === undefined && options.budget !== undefined) data.optimizer = { name: 'dspy.GEPA',
        status: 'Observed progress; evaluation count includes completed trial reports',
        evaluations: trials.filter((trial) => trial.phase !== 'test').length, proposals: proposalAttempts, ...options.budget };
      data.usage = [...data.usage.filter((entry) => entry.purpose !== 'optimizer'), ...generations];
      await options.store.appendEvent(runId, { id: randomUUID(), payload: data }, 'public');
      unavailable = false;
    } catch {
      unavailable = true;
      options.io.stderr('Viewer snapshot unavailable; native evidence capture continues.\n');
    }
  };
  await publish();
  const server = await startViewer({ port: options.port, load: async () => {
    if (unavailable) throw new Error('Viewer snapshot unavailable');
    const replay = await options.store.readReplay(runId, { audience: 'viewer', phase: 'training' });
    return replay.events.at(-1)!.payload as ViewerData;
  } });
  options.io.stdout(`${JSON.stringify({ viewer: server.url, progressRunId: runId })}\n`);
  return {
    close: () => server.close(),
    async observe(event: { type: string; payload: unknown }) {
      if (event.type === 'trial.finished') {
        const report = event.payload as TrialReport;
        if (report.phase === 'test' && !frozen) return;
        trials.push(report); status = 'running';
      } else if (event.type === 'training.started') {
        const payload = event.payload as { train: string[]; validation: string[] };
        cases = [...payload.train.map((id) => ({ id, split: 'train' as const })),
          ...payload.validation.map((id) => ({ id, split: 'validation' as const }))];
        status = 'optimizing';
      } else if (event.type === 'selection.frozen') {
        frozen = true; optimizer = (event.payload as { optimizer: DspyResult }).optimizer;
        cases = [...cases, ...options.testCases]; status = 'testing frozen selection';
      } else if (event.type === 'optimizer.generation.started') {
        proposalAttempts = (event.payload as { attempt: number }).attempt; status = 'reflecting';
      } else if (event.type === 'optimizer.generation.completed') {
        const payload = event.payload as Omit<ViewerData['usage'][number], 'purpose'>;
        generations.push({ purpose: 'optimizer', model: payload.model, route: payload.route, usage: payload.usage });
      } else if (event.type === 'training.completed' || event.type === 'evaluation.completed') status = 'completed';
      else return;
      await publish();
    },
  };
}
