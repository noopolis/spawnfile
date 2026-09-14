import { z } from 'zod';
import type { CandidateManifest } from '../../candidates/index.js';
import type { CostReport, TrainingCostPlan, TrialReport } from '../../experiments/index.js';
import type { ExperimentStore } from '../../storage/index.js';
import { projectTrials, projectViewerData, type ViewerData } from '../../../viewer/index.js';
import type { InvocationIndex } from '../types.js';
import type { RescoreReport } from '../../experiments/replay/index.js';

export interface CliFailureReport {
  schema: 'paideia.cli-failure.v1';
  id: string;
  command: 'train' | 'evaluate';
  candidateId: string;
  status: 'failed';
  progressRunId: string;
  diagnosticId: string;
  view: ViewerData;
}

export function createFailureReport(options: {
  id: string; command: CliFailureReport['command']; baseline: CandidateManifest;
  progressRunId: string; diagnosticId: string; trials: readonly TrialReport[];
  costs: CostReport; costPlan?: TrainingCostPlan;
  rescores?: readonly RescoreReport[];
}): CliFailureReport {
  const trials = options.trials.filter(trial => trial.phase !== 'test');
  const cases = [...new Map(trials.map(trial => [trial.recordId, { id: trial.recordId, split: trial.phase }])).values()];
  const view = projectTrials({ id: options.id, title: 'Failed experiment; partial development results', phase: 'replay',
    status: 'failed', updatedAt: new Date().toISOString(), baseline: options.baseline, cases, trials,
    costs: options.costs, costPlan: options.costPlan,
    rescores: options.rescores?.filter(score => score.original.phase !== 'test') });
  // The cost projection keeps every observed call, including sealed work, while
  // omitting call/trial identities and provider text. Do not expose usage sources.
  view.usage = [];
  return { schema: 'paideia.cli-failure.v1', id: options.id, command: options.command,
    candidateId: options.baseline.id, status: 'failed', progressRunId: options.progressRunId,
    diagnosticId: options.diagnosticId, view: projectViewerData(view) };
}

const id = z.string().min(1).max(16384);
const failureSchema = z.object({ schema: z.literal('paideia.cli-failure.v1'), id,
  command: z.enum(['train', 'evaluate']), candidateId: id, status: z.literal('failed'),
  progressRunId: id, diagnosticId: id, view: z.unknown() }).strict();

export async function loadFailureView(value: unknown, index: InvocationIndex, store: ExperimentStore): Promise<ViewerData> {
  const report = failureSchema.parse(value);
  if (report.id !== index.summaryRunId || report.command !== index.command || report.candidateId !== index.candidateId) {
    throw new Error('Stored failure report does not match its invocation');
  }
  const view = projectViewerData(report.view as ViewerData);
  if (view.experiment.id !== report.id || view.experiment.status !== 'failed' || view.experiment.phase !== 'replay'
      || view.candidates.length !== 1 || view.candidates[0]!.id !== index.candidateId || view.usage.length
      || view.cases.some(record => record.split === 'test')
      || new Set(index.trialIds).size !== index.trialIds.length
      || JSON.stringify(view.trials.map(trial => trial.id)) !== JSON.stringify(index.trialIds)) {
    throw new Error('Failure replay contains inconsistent identities, phases or status');
  }
  for (const trial of view.trials) {
    // A modified index cannot authorize a sealed trial by relabeling its case.
    const replay = await store.readReplay(trial.id, { audience: 'viewer', phase: 'replay' });
    if (replay.manifest.recordId !== trial.caseId || replay.manifest.candidateId !== trial.candidateId
        || !view.cases.some(record => record.id === trial.caseId && record.split === replay.manifest.datasetRole)) {
      throw new Error('Failure replay trial does not match its stored manifest');
    }
  }
  return view;
}
