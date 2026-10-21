import type { EvaluationResult, PlanEvaluation } from '../../contracts/evaluation.js';
import type { DataMap, ResolvedRecord } from '../../contracts/dataset.js';
import type { TrialReport } from '../trials/index.js';
import type { AtomicFeedback } from '../../graders/atomic/index.js';
import { createHash } from 'node:crypto';

export const trainingFeedbackLimits = { outputBytes: 16384, feedbackBytes: 32768, atomicBytes: 8192, atomicChecks: 40, unitChars: 1000 } as const;

/** Bound the actual UTF-8 wire size, retaining an identifiable article/diagnostic excerpt. */
function boundedText(text: string, limit: number): string {
  const originalBytes = Buffer.byteLength(text);
  if (originalBytes <= limit) return text;
  const value = { truncated: true, originalBytes, sha256: createHash('sha256').update(text).digest('hex'), excerpt: '' };
  return excerptText(value, text, limit);
}

/** Structured evidence is fixed; only the optional excerpt competes for remaining bytes. */
function excerptText(value: { excerpt: string }, text: string, limit: number): string {
  if (Buffer.byteLength(JSON.stringify(value)) > limit) throw new Error('Structured training feedback exceeds its byte budget');
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const middle = Math.ceil((lo + hi) / 2);
    value.excerpt = text.slice(0, middle);
    if (Buffer.byteLength(JSON.stringify(value)) <= limit) lo = middle;
    else hi = middle - 1;
  }
  value.excerpt = text.slice(0, lo);
  return JSON.stringify(value);
}

/** Do not infer failures from protected checks or change the grader's threshold. */
function compactAtomic(feedback: AtomicFeedback, limit: number = trainingFeedbackLimits.atomicBytes): AtomicFeedback {
  const value: AtomicFeedback = { failed_check_count: feedback.failed_check_count,
    omitted_failed_checks: feedback.failed_check_count, failed_checks: [] };
  for (const check of feedback.failed_checks.slice(0, trainingFeedbackLimits.atomicChecks)) {
    value.failed_checks.push({ template: check.template.slice(0, 256),
      unit: check.unit.slice(0, trainingFeedbackLimits.unitChars), probability: check.probability });
    value.omitted_failed_checks--;
    if (Buffer.byteLength(JSON.stringify(value)) > limit) {
      value.failed_checks.pop(); value.omitted_failed_checks++; break;
    }
  }
  return value;
}

/** Only authored task outputs are optimizer-visible; collector metadata is not output. */
function taskOutput(record: ResolvedRecord, report: TrialReport): string {
  const collectors = record.setup?.artifacts as DataMap | undefined;
  const names = new Set([...Object.keys(record.outputs ?? {}), ...Object.keys(collectors ?? {})]);
  if (names.size === 0) return boundedText(report.snapshot.output, trainingFeedbackLimits.outputBytes);
  const artifacts = Object.fromEntries([...names].map(name => {
    const artifact = Object.hasOwn(report.snapshot.artifacts, name) ? report.snapshot.artifacts[name] : undefined;
    return [name, artifact?.value === undefined ? { status: 'unavailable' }
      : { status: 'available', value: artifact.value }];
  }));
  const original = JSON.stringify({ output: { text: report.snapshot.output }, artifacts });
  if (Buffer.byteLength(original) <= trainingFeedbackLimits.outputBytes) return original;
  const compact = { truncated: true, originalBytes: Buffer.byteLength(original),
    sha256: createHash('sha256').update(original).digest('hex'), output: { text: '' },
    artifacts: Object.fromEntries([...names].map(name => [name, { status: artifacts[name]!.status }])) as Record<string, { status: string; value?: unknown }> };
  // Every declared artifact gets its own share before optional chat, including JSON escaping.
  const remaining = trainingFeedbackLimits.outputBytes - Buffer.byteLength(JSON.stringify(compact)) - 256;
  const share = Math.floor(remaining / names.size) - 16;
  if (share < 256) throw new Error('Declared artifact identifiers exceed the training output byte budget');
  for (const name of names) {
    const source = artifacts[name]!;
    if ('value' in source) compact.artifacts[name]!.value = JSON.parse(boundedText(JSON.stringify(source.value), share));
  }
  let lo = 0, hi = report.snapshot.output.length;
  while (lo < hi) {
    const middle = Math.ceil((lo + hi) / 2);
    compact.output.text = report.snapshot.output.slice(0, middle);
    if (Buffer.byteLength(JSON.stringify(compact)) <= trainingFeedbackLimits.outputBytes) lo = middle;
    else hi = middle - 1;
  }
  compact.output.text = report.snapshot.output.slice(0, lo);
  return JSON.stringify(compact);
}

function checkFeedback(check: EvaluationResult, measurementsOnly = false): unknown {
  return { id: check.id, status: check.status, score: check.score, finality: check.finality,
    ...(!measurementsOnly ? { reason: check.reason,
      ...(check.atomicGrading ? { atomic: compactAtomic(check.atomicGrading.feedback) } : {}) } : {}),
    ...(check.children?.length ? { children: check.children.map(child => checkFeedback(child, measurementsOnly)) } : {}) };
}

function evaluationFeedback(evaluation: PlanEvaluation, measurementsOnly = false) {
  return { status: evaluation.status, stages: evaluation.stages.map(stage => ({
    id: stage.id, checks: stage.checks.map(check => checkFeedback(check, measurementsOnly)),
    gate: { status: stage.gate.status }, score: stage.score, weights: stage.weights,
  })) };
}

/** Present only when the subject ran out of a budget it declared; other reports keep their bytes. */
function executionFeedback(report: TrialReport) {
  return report.execution === 'limit-exceeded' ? { execution: { status: report.execution, limit: report.limit ?? null,
    note: `The candidate exhausted its declared ${report.limit ?? 'unknown'} budget before finishing the task; work left unfinished was graded as missing.` } } : {};
}

function feedbackText(value: unknown, evaluation: PlanEvaluation, report: TrialReport): string {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) <= trainingFeedbackLimits.feedbackBytes) return text;
  const atomic: AtomicFeedback = { failed_check_count: 0, omitted_failed_checks: 0, failed_checks: [] };
  const collect = (check: EvaluationResult) => {
    if (check.atomicGrading) {
      const item = compactAtomic(check.atomicGrading.feedback);
      atomic.failed_check_count += item.failed_check_count;
      atomic.failed_checks.push(...item.failed_checks);
    }
    check.children?.forEach(collect);
  };
  evaluation.stages.forEach(stage => stage.checks.forEach(collect));
  report.live.forEach(item => collect(item.result));
  const compact = { truncated: true, originalBytes: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex'), excerpt: '', ...executionFeedback(report),
    evaluation: evaluationFeedback(evaluation, true), subjectUsage: report.snapshot.subjectUsage ?? null,
    live: report.live.map(item => ({ checkId: item.checkId, boundary: item.boundary, result: checkFeedback(item.result, true) })),
    atomic: { failed_check_count: atomic.failed_check_count, omitted_failed_checks: atomic.failed_check_count, failed_checks: [] } as AtomicFeedback };
  const remaining = trainingFeedbackLimits.feedbackBytes - Buffer.byteLength(JSON.stringify(compact));
  compact.atomic = compactAtomic(atomic, Math.min(trainingFeedbackLimits.atomicBytes, remaining));
  return excerptText(compact, text, trainingFeedbackLimits.feedbackBytes);
}

/** Validation and test captures never supply optimizer text, even when outputs are declared. */
export function trainingFeedback(record: ResolvedRecord, report: TrialReport, evaluation: PlanEvaluation = report.evaluation): { output: string; feedback: string } {
  if (report.phase !== 'train') return { output: '', feedback: '' };
  return { output: taskOutput(record, report), feedback: feedbackText({ task: record.input ?? record.turns,
    criteria: record.effectiveStages, ...executionFeedback(report),
    evaluation: evaluationFeedback(evaluation),
    subjectUsage: report.snapshot.subjectUsage ?? null,
    live: report.live.map(item => ({ checkId: item.checkId, boundary: item.boundary, result: checkFeedback(item.result) })) }, evaluation, report) };
}
