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

/** Validation and test captures never supply optimizer text, even when outputs are declared. */
export function trainingFeedback(record: ResolvedRecord, report: TrialReport): { output: string; feedback: string } {
  if (report.phase !== 'train') return { output: '', feedback: '' };
  return { output: taskOutput(record, report), feedback: JSON.stringify({ task: record.input ?? record.turns,
    criteria: record.effectiveStages, evaluation: report.evaluation, live: report.live }) };
}
