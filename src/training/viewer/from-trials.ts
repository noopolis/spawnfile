import type { CandidateManifest } from '../src/candidates/index.js';
import type { EvaluationResult } from '../src/contracts/index.js';
import { trialScore, type TrialReport, type TrainingReport, type ComparisonReport } from '../src/experiments/index.js';
import type { DspyResult } from '../src/optimization/index.js';
import type { CostReport, TrainingCostPlan } from '../src/experiments/costs/index.js';
import type { RescoreReport } from '../src/experiments/replay/index.js';
import type { ViewerCheck, ViewerData } from './types.js';
import { projectCosts } from './costs.js';

export interface TrialProjectionOptions {
  id: string;
  title: string;
  phase: ViewerData['experiment']['phase'];
  status: string;
  updatedAt: string;
  cases: ViewerData['cases'];
  baseline: CandidateManifest;
  trials: readonly TrialReport[];
  comparison?: { candidate: CandidateManifest; name: string };
  optimizer?: DspyResult;
  budget?: { maxMetricCalls: number; maxProposals: number };
  costs?: CostReport;
  costPlan?: TrainingCostPlan;
  rescores?: readonly RescoreReport[];
}

function checkView(check: EvaluationResult, fallback: string, weights?: Record<string, number>): ViewerCheck {
  const weight = check.id === undefined ? undefined : weights?.[check.id];
  const raw = check.status === 'pass' || check.status === 'fail' ? check.score ?? (check.status === 'pass' ? 1 : 0) : null;
  return { id: check.id ?? fallback, label: check.id ?? fallback, status: check.status, score: check.score ?? null,
    // Without this the viewer published `status: error` and no cause at all, and a
    // whole training run ended on a judge nobody could name. The weight still shows.
    ...(check.judgeFailure ? { judgeFailure: structuredClone(check.judgeFailure) } : {}),
    ...(weight === undefined ? {} : { weight, weightedContribution: raw === null ? null :
      raw * weight / Object.values(weights!).reduce((sum, value) => sum + value, 0) }),
    evidenceIds: check.evidence.map((reference) => reference.id),
    children: (check.children ?? []).map((child, index) => checkView(child, `${fallback}/${index}`)) };
}

function displayedScore(trial: TrialReport | RescoreReport): number | null {
  try { return trialScore(trial); } catch { return null; }
}

/** Observable presentation fields only: never subject output, prompts, context, tool args/results or judge reasons. */
export function projectTrials(options: TrialProjectionOptions): ViewerData {
  if (options.comparison && options.optimizer) throw new Error('Authored comparison cannot contain optimizer provenance');
  const measurement = (trial:TrialReport) => options.rescores?.findLast(score=>score.runId===trial.id) ?? trial;
  const data: ViewerData = {
    schema: 'paideia.viewer.v1', experiment: { id: options.id, title: options.title, phase: options.phase,
      status: options.status, updatedAt: options.updatedAt }, cases: options.cases,
    trials: options.trials.map((trial) => ({ id: trial.id, caseId: trial.recordId, candidateId: trial.candidateId,
      status: `${measurement(trial).status} (${measurement(trial) === trial ? '' : `rescored; original ${trial.status}; `}${trial.execution}; host work ${trial.hostWork})`, score: displayedScore(measurement(trial)),
      coverage: [...trial.snapshot.coverage],
      checks: measurement(trial).evaluation.stages.map((stage) => ({ id: stage.id, label: stage.id, status: stage.gate.status,
        score: stage.score?.lower ?? null, evidenceIds: stage.gate.evidence.map((reference) => reference.id),
        children: [...stage.checks.map((check, index) => checkView(check, `${stage.id}/${index}`, stage.weights)), checkView(stage.gate, `${stage.id}/gate`)] })),
      events: trial.snapshot.events.map((event) => ({ id: event.id, type: event.type, timestamp: event.timestamp,
        summary: `${event.tool ?? event.type}${event.success === undefined ? '' : event.success ? ' succeeded' : ' failed'}` })),
    })),
    candidates: [{ id: options.baseline.id, nativeId: options.baseline.id, parentIds: [], validationScore: null, discoveryEvaluations: 0,
      editablePaths: options.baseline.resources.filter((resource) => resource.edit !== 'locked').map((resource) => resource.sourcePath) }],
    usage: options.trials.flatMap((trial) => trial.turns.map((turn) => ({ purpose: 'subject' as const,
      model: null, route: null, usage: turn.native.usage }))),
  };
  if (options.comparison) {
    data.candidates[0]!.label = 'Baseline';
    data.candidates.push({ ...data.candidates[0]!, id: options.comparison.candidate.id, nativeId: options.comparison.candidate.id,
      label: options.comparison.name, parentIds: [options.baseline.id] });
  }
  const visibleIds = new Set(options.trials.map(trial => trial.id));
  const hiddenIds = new Set(options.costs?.entries.flatMap(entry => entry.trialId && !visibleIds.has(entry.trialId) ? [entry.trialId] : []));
  const costs = projectCosts(options.costs, options.costPlan, hiddenIds);
  if (costs !== undefined) data.costs = costs;
  if (options.optimizer !== undefined) {
    const { provenance } = options.optimizer;
    const validation = provenance.captures.filter((capture) => capture.split === 'validation');
    const size = options.cases.filter((record) => record.split === 'validation').length;
    const trials = new Map(options.trials.map((trial) => [trial.id, trial]));
    const labels = provenance.candidates.map((_candidate, index) => {
      const captured = trials.get(validation[index * size]?.captureId ?? '');
      if (!captured) throw new Error('GEPA lineage has no matching stored native validation trial');
      return `GEPA ${index}: ${captured.candidateId}`;
    });
    data.candidates = provenance.candidates.map((candidate, index) => ({ id: labels[index]!,
      nativeId: trials.get(validation[index * size]!.captureId)!.candidateId,
      parentIds: candidate.parents.filter((parent): parent is number => parent !== null).map((parent) => labels[parent]!),
      validationScore: candidate.validationScore, discoveryEvaluations: candidate.discoveryEvaluations,
      editablePaths: data.candidates[0]!.editablePaths }));
    data.usage.push(...provenance.generations.map((generation) => ({ purpose: 'optimizer' as const,
      model: generation.model, modelBasis: generation.modelBasis, route: null, usage: generation.usage })));
    if (options.budget !== undefined) data.optimizer = { name: provenance.optimizer, status: 'selection frozen',
      evaluations: provenance.evaluations, proposals: provenance.proposals, ...options.budget,
      selectedCandidateId: labels[provenance.selectedCandidateIndex] };
  }
  return data;
}

export function projectTrainingReport(report: TrainingReport, budget?: TrialProjectionOptions['budget']): ViewerData {
  const data = projectTrials({ id: report.id, title: 'Completed training experiment', phase: 'final-test', status: 'completed',
    updatedAt: 'Recorded completion', baseline: report.baseline, trials: report.trials, optimizer: report.optimizer, budget,
    costs: report.costs, costPlan: report.costPlan, rescores: report.rescores,
    cases: Object.entries(report.partitions).flatMap(([phase, ids]) => ids.map((id) => ({ id,
      split: phase as 'train' | 'validation' | 'test' }))) });
  if (report.heldOut.some(arm => arm.trialScores !== undefined)) data.heldOut = report.heldOut.map(({ candidateId, meanScore, trialScores, standardError }) =>
    ({ candidateId, meanScore, trialScores, standardError }));
  return data;
}

export function projectComparisonReport(report: ComparisonReport): ViewerData {
  return projectTrials({ id: report.id, title: `Authored comparison: ${report.name}`, phase: 'final-test', status: 'completed',
    updatedAt: 'Recorded completion', baseline: report.baseline, comparison: { candidate: report.candidate, name: report.name },
    trials: report.trials, costs: report.costs, costPlan: report.costPlan, rescores: report.rescores,
    cases: Object.entries(report.partitions).flatMap(([phase, ids]) => ids.map(id => ({ id, split: phase as 'train' | 'validation' | 'test' }))) });
}
