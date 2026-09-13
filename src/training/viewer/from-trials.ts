import type { CandidateManifest } from '../src/candidates/index.js';
import type { EvaluationResult } from '../src/contracts/index.js';
import { trialScore, type TrialReport, type TrainingReport } from '../src/experiments/index.js';
import type { DspyResult } from '../src/optimization/index.js';
import type { ViewerCheck, ViewerData } from './types.js';

export interface TrialProjectionOptions {
  id: string;
  title: string;
  phase: ViewerData['experiment']['phase'];
  status: string;
  updatedAt: string;
  cases: ViewerData['cases'];
  baseline: CandidateManifest;
  trials: readonly TrialReport[];
  optimizer?: DspyResult;
  budget?: { maxMetricCalls: number; maxProposals: number };
}

function checkView(check: EvaluationResult, fallback: string): ViewerCheck {
  return { id: check.id ?? fallback, label: check.id ?? fallback, status: check.status, score: check.score ?? null,
    evidenceIds: check.evidence.map((reference) => reference.id),
    children: (check.children ?? []).map((child, index) => checkView(child, `${fallback}/${index}`)) };
}

function displayedScore(trial: TrialReport): number | null {
  try { return trialScore(trial); } catch { return null; }
}

/** Observable presentation fields only: never subject output, prompts, context, tool args/results or judge reasons. */
export function projectTrials(options: TrialProjectionOptions): ViewerData {
  const data: ViewerData = {
    schema: 'paideia.viewer.v1', experiment: { id: options.id, title: options.title, phase: options.phase,
      status: options.status, updatedAt: options.updatedAt }, cases: options.cases,
    trials: options.trials.map((trial) => ({ id: trial.id, caseId: trial.recordId, candidateId: trial.candidateId,
      status: `${trial.status} (${trial.execution}; host work ${trial.hostWork})`, score: displayedScore(trial),
      coverage: [...trial.snapshot.coverage],
      checks: trial.evaluation.stages.map((stage) => ({ id: stage.id, label: stage.id, status: stage.gate.status,
        score: stage.score?.lower ?? null, evidenceIds: stage.gate.evidence.map((reference) => reference.id),
        children: [...stage.checks.map((check, index) => checkView(check, `${stage.id}/${index}`)), checkView(stage.gate, `${stage.id}/gate`)] })),
      events: trial.snapshot.events.map((event) => ({ id: event.id, type: event.type, timestamp: event.timestamp,
        summary: `${event.tool ?? event.type}${event.success === undefined ? '' : event.success ? ' succeeded' : ' failed'}` })),
    })),
    candidates: [{ id: options.baseline.id, parentIds: [], validationScore: null, discoveryEvaluations: 0,
      editablePaths: options.baseline.resources.filter((resource) => resource.edit !== 'locked').map((resource) => resource.sourcePath) }],
    usage: options.trials.flatMap((trial) => trial.turns.map((turn) => ({ purpose: 'subject' as const,
      model: null, route: null, usage: turn.native.usage }))),
  };
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
      parentIds: candidate.parents.filter((parent): parent is number => parent !== null).map((parent) => labels[parent]!),
      validationScore: candidate.validationScore, discoveryEvaluations: candidate.discoveryEvaluations,
      editablePaths: data.candidates[0]!.editablePaths }));
    data.usage.push(...provenance.generations.map((generation) => ({ purpose: 'optimizer' as const,
      model: generation.model, route: null, usage: generation.usage })));
    if (options.budget !== undefined) data.optimizer = { name: provenance.optimizer, status: 'selection frozen',
      evaluations: provenance.evaluations, proposals: provenance.proposals, ...options.budget,
      selectedCandidateId: labels[provenance.selectedCandidateIndex] };
  }
  return data;
}

export function projectTrainingReport(report: TrainingReport, budget?: TrialProjectionOptions['budget']): ViewerData {
  return projectTrials({ id: report.id, title: 'Completed training experiment', phase: 'final-test', status: 'completed',
    updatedAt: 'Recorded completion', baseline: report.baseline, trials: report.trials, optimizer: report.optimizer, budget,
    cases: Object.entries(report.partitions).flatMap(([phase, ids]) => ids.map((id) => ({ id,
      split: phase as 'train' | 'validation' | 'test' }))) });
}
