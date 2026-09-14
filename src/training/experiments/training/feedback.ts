import type { EvaluationResult, PlanEvaluation } from '../../contracts/evaluation.js';
import type { DataMap, ResolvedRecord } from '../../contracts/dataset.js';
import type { TrialReport } from '../trials/index.js';

/** Only authored task outputs are optimizer-visible; collector metadata is not output. */
function taskOutput(record: ResolvedRecord, report: TrialReport): string {
  const collectors = record.setup?.artifacts as DataMap | undefined;
  const names = new Set([...Object.keys(record.outputs ?? {}), ...Object.keys(collectors ?? {})]);
  if (names.size === 0) return report.snapshot.output;
  const artifacts = Object.fromEntries([...names].map(name => {
    const artifact = Object.hasOwn(report.snapshot.artifacts, name) ? report.snapshot.artifacts[name] : undefined;
    return [name, artifact?.value === undefined ? { status: 'unavailable' }
      : { status: 'available', value: artifact.value }];
  }));
  return JSON.stringify({ output: { text: report.snapshot.output }, artifacts });
}

function checkFeedback(check: EvaluationResult): unknown {
  return { id: check.id, status: check.status, score: check.score, finality: check.finality, reason: check.reason,
    ...(check.children?.length ? { children: check.children.map(checkFeedback) } : {}) };
}

/** Validation and test captures never supply optimizer text, even when outputs are declared. */
export function trainingFeedback(record: ResolvedRecord, report: TrialReport, evaluation: PlanEvaluation = report.evaluation): { output: string; feedback: string } {
  if (report.phase !== 'train') return { output: '', feedback: '' };
  return { output: taskOutput(record, report), feedback: JSON.stringify({ task: record.input ?? record.turns,
    criteria: record.effectiveStages,
    evaluation: { status: evaluation.status, stages: evaluation.stages.map(stage => ({
      id: stage.id, checks: stage.checks.map(checkFeedback), gate: { status: stage.gate.status },
      score: stage.score, weights: stage.weights,
    })) },
    subjectUsage: report.snapshot.subjectUsage ?? null,
    live: report.live.map(item => ({ checkId: item.checkId, boundary: item.boundary, result: checkFeedback(item.result) })) }) };
}
