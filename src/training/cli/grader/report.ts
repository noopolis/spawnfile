import type { CalibrationFile, CalibrationMetrics, GoldenSource } from '../../graders/index.js';

export interface QuestionDiagnostics {
  missingRate: number;
  boundedRate: number;
  sourceMix: Record<GoldenSource, number>;
  sourceAgreement?: Record<string, { instances: number; agreement: number }>;
  bySource?: Partial<Record<GoldenSource, CalibrationMetrics>>;
  permutation?: { compared: number; missing: number; flipRate: number | null };
}
const number = (value: number | null | undefined): string => value == null ? '—' : value.toFixed(3);
const safe = (value: string): string => value.replaceAll('|', '\\|').replaceAll('\n', ' ');

export function calibrationReport(file: CalibrationFile, diagnostics: Record<string, QuestionDiagnostics>, counts: {
  excluded: number; disputed: number; unavailable: number;
}): string {
  const lines = ['# Grader calibration', '',
    'Metrics measure agreement with teacher consensus, not validated correctness, unless human- or editor-adjudicated labels are present.',
    'Held-out lineages never choose parameters or bands. ECE/Brier intervals use 1,000 whole-lineage bootstrap resamples (90%).',
    'Missing decisions remain in held-out counts and count wrong; Brier assigns loss 1 and ECE assigns maximum error to missing mass (conservative penalties, not imputed predictions).',
    'Teacher-only backends report independent-labeler agreement; they do not claim ECE or calibrated probabilities.',
    'Bounded Ollama scores use the conservative lower p(good): absent expected options get zero, absent unexpected options get the smallest candidate probability before normalization.',
    'Model benchmark calibration is a prior, not evidence that this grader is calibrated. No labels are used as few-shot examples.',
    '', `Excluded outputs: ${counts.excluded}; disputed instances: ${counts.disputed}; unavailable projections: ${counts.unavailable}.`, '',
    '| Question | Status | Groups | n | Base rate | Accuracy/agreement | Brier | Baseline Brier | ECE [90% CI] | Band / rate | Missing / bounded | Human / editor / consensus / single |',
    '|---|---|---:|---:|---:|---:|---:|---:|---|---|---|---|'];
  for (const [id, result] of Object.entries(file.questions)) {
    const m = result.metrics, d = diagnostics[id]!;
    lines.push(`| ${safe(id)} | ${result.status} | ${m.groups} | ${m.instances} | ${number(m.baseRate)} | ${number(m.accuracy ?? m.agreement)} | ${number(m.brier)} | ${number(m.baseRateBrier)} | ${number(m.ece)} ${m.eceInterval ? `[${m.eceInterval.map(number).join(', ')}]` : ''} | ${result.band?.map(number).join('–') ?? '—'} / ${number(m.escalationRate)} | ${number(d.missingRate)} / ${number(d.boundedRate)} | ${d.sourceMix.human} / ${d.sourceMix.editor} / ${d.sourceMix.consensus} / ${d.sourceMix['single-teacher']} |`);
  }
  for (const [id, result] of Object.entries(file.questions)) {
    const d = diagnostics[id]!;
    lines.push('', `## ${safe(id)}`, '', ...result.failures.map(failure => `- ${failure}`));
    for (const [source, metrics] of Object.entries(d.bySource ?? {})) {
      lines.push(`- ${source}: n=${metrics.instances}, accuracy=${number(metrics.accuracy)}, Brier=${number(metrics.brier)}, ECE=${number(metrics.ece)}.`);
    }
    for (const [source, metrics] of Object.entries(d.sourceAgreement ?? {})) {
      lines.push(`- ${source}: n=${metrics.instances}, independent agreement=${number(metrics.agreement)}; ECE not claimed.`);
    }
    if (result.teacherAccuracy) {
      const t = result.teacherAccuracy;
      lines.push(`- Teacher independent held-out accuracy: ${number(t.agreement)}; source: ${t.source}; groups: ${t.groups}; instances: ${t.instances}; good/bad: ${t.good}/${t.bad}.`,
        ...t.failures.map(failure => `- Teacher bar: ${safe(failure)}`), ...t.warnings.map(warning => `- ${safe(warning)}`));
    }
    if (d.permutation) lines.push(`- Reversed option order: ${d.permutation.compared} compared, ${d.permutation.missing} missing; decision flip rate ${number(d.permutation.flipRate ?? undefined)}.`);
    lines.push(`- False-pass rate: ${number(result.metrics.falsePassRate)}; cascade accuracy: ${number(result.metrics.cascadeAccuracy)}${result.metrics.cascadeInterval ? ` [90% CI ${result.metrics.cascadeInterval.map(number).join(', ')}]` : ''}.`);
  }
  lines.push('', 'Escalation calls are grouped by output/projection; per-output overflow counts wrong. Cost estimates require labeling calls of the same shape; unavailable measurements are unknown, never zero.', '');
  return lines.join('\n');
}
