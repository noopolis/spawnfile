import type { CriticGateReport } from '../../critic/index.js';
import type { GapDecision, GapGateReport, RescoreReport, TrainingReport, TrialReport } from '../../experiments/index.js';
import { renderQuestionnaireMarkdown, summarizeQuestionnaire, type CalibrationRun, type QuestionnaireResult, type QuestionnaireSummary } from '../../questionnaire/index.js';

type Split = 'train' | 'validation' | 'test';
export interface VerifierSummary {
  /** Per questionnaire check, per split, per candidate label: pass rates, gates and the open, hidden and full scores. */
  questionnaires: Record<string, Partial<Record<Split, Record<string, QuestionnaireSummary>>>>;
  /** Critic reviews behind the frozen selection, with candidate labels. */
  critic: (Omit<CriticGateReport, 'reviews'> & { reviews: (CriticGateReport['reviews'][number] & { label: string })[] }) | null;
  /** Calibration sets judged before the first trial. */
  calibration: CalibrationRun[];
  /** The gap rule's measurement of every candidate considered, with candidate labels. */
  selection: (Omit<GapGateReport, 'candidates'> & { candidates: (GapDecision & { label: string })[] }) | null;
}

/** Operator-only: hidden questions appear here and nowhere an optimizer reads. Uses each trial's latest measurement. */
export function summarizeVerifiers(report: TrainingReport, labels: ReadonlyMap<string, string>,
  latest: (trial: TrialReport) => RescoreReport | undefined): VerifierSummary {
  const found = new Map<string, QuestionnaireResult[]>();
  for (const trial of report.trials) {
    if (report.retries?.some(retry => retry.failedTrialId === trial.id)) continue;
    const evaluation = (latest(trial) ?? trial).evaluation;
    for (const stage of evaluation.stages) for (const check of stage.checks) {
      if (!check.questionnaire) continue;
      const key = JSON.stringify([check.id ?? 'questionnaire', trial.phase, labels.get(trial.candidateId) ?? trial.candidateId]);
      found.set(key, [...found.get(key) ?? [], check.questionnaire]);
    }
  }
  const questionnaires: VerifierSummary['questionnaires'] = {};
  for (const [key, results] of found) {
    const [check, split, label] = JSON.parse(key) as [string, Split, string];
    ((questionnaires[check] ??= {})[split] ??= {})[label] = summarizeQuestionnaire(results);
  }
  return { questionnaires, critic: report.critic ? { ...report.critic,
    reviews: report.critic.reviews.map(entry => ({ ...entry, label: labels.get(entry.candidateId) ?? entry.candidateId })) } : null,
    calibration: report.calibration ?? [],
    selection: report.selection ? { ...report.selection,
      candidates: report.selection.candidates.map(entry => ({ ...entry, label: labels.get(entry.candidateId) ?? entry.candidateId })) } : null };
}

const cell = (value: unknown) => String(value).replace(/\|/gu, '&#124;').replace(/[\r\n]+/gu, ' ');

const shown = (value: number | null) => value === null ? 'n/a' : value.toFixed(3);

export function renderVerifiersMarkdown(summary: VerifierSummary): string[] {
  const lines: string[] = [];
  if (summary.calibration.length) {
    lines.push('## Calibration', '', 'Judged on the run\'s own judge routes before the first trial. A set the bank misses refuses the run.', '');
    for (const run of summary.calibration) {
      const report = run.report;
      lines.push(`- ${cell(run.set)} on ${cell(run.check)} (bank ${cell(run.bank.id)}): **${report.ok ? 'pass' : 'fail'}**. Defects caught ${report.caught} of ${report.defects}; required gates failed ${report.gateFailed} of ${report.gateRequired}; clean outputs failing a gate ${report.cleanBasesFailing.length} of ${report.cleanBases}; clean false alarms ${report.cleanFalseAlarms.length}. ${run.outputs} outputs, ${run.judgeCallsAsked} judge calls asked by this invocation.`);
    }
    lines.push('');
  }
  if (summary.selection) {
    const rule = summary.selection.rule, baseline = summary.selection.baseline;
    lines.push('## Open and hidden gap rule', '',
      `Over validation trials. A candidate is removed from selection when its open minus hidden gap exceeds the baseline's by more than ${rule.max_gap ?? 'n/a (not declared)'}, or its gate failure rate exceeds the baseline's by more than ${rule.max_gate_failure_rise ?? 'n/a (not declared)'}${summary.selection.acceptance ? ", or it accepts (passes every gate) less often than the baseline" : ''}.`, '',
      '| Candidate | Trials | Open | Hidden | Open minus hidden | Gate failure rate | Acceptance | Decision |', '| --- | --- | --- | --- | --- | --- | --- | --- |',
      `| baseline | ${baseline.trials} | ${shown(baseline.scoreOpen)} | ${shown(baseline.scoreHidden)} | ${shown(baseline.gap)} | ${shown(baseline.gateFailureRate)} | ${shown(baseline.acceptance ?? null)} | reference |`,
      ...summary.selection.candidates.map(entry => `| ${cell(entry.label)} | ${entry.trials} | ${shown(entry.scoreOpen)} | ${shown(entry.scoreHidden)} | ${shown(entry.gap)} | ${shown(entry.gateFailureRate)} | ${shown(entry.acceptance ?? null)} | ${entry.rejected ? `rejected: ${cell(entry.reason)}` : 'kept'} |`), '');
  }
  for (const [check, splits] of Object.entries(summary.questionnaires)) {
    lines.push(`## Questionnaire ${cell(check)}`, '', 'Operator-only. Hidden questions never reach the optimizer; the search and selection use the full score. A candidate whose open score rises while its hidden score does not has learned the visible questions.', '');
    for (const split of ['train', 'validation', 'test'] as const) {
      const candidates = splits[split];
      if (!candidates) continue;
      lines.push(`### ${split}`, '', renderQuestionnaireMarkdown(Object.fromEntries(Object.entries(candidates).map(([label, value]) => [label, { summary: value }]))), '');
    }
  }
  if (summary.critic) {
    lines.push('## Prompt critic', '', `Selected after review: ${cell(summary.critic.selectedId)}.${summary.critic.displacedId ? ` The search's own choice ${cell(summary.critic.displacedId)} was removed from selection.` : ''}`, '');
    for (const entry of summary.critic.reviews) {
      lines.push(`### ${cell(entry.label)}: ${entry.review.verdict}${entry.selected ? ' (selected)' : ' (removed from selection)'}`, '',
        entry.review.error ? `Review failed: ${cell(entry.review.error)}.` : cell(entry.review.summary), '',
        ...entry.review.findings.map(finding => `- ${finding.category}, ${finding.severity}${finding.case ? `, case ${cell(finding.case)}` : ''}${finding.unverifiedQuote ? ', quote not found in the prompt' : ''}: "${cell(finding.quoted_line)}". ${cell(finding.why)}${finding.guide_ref ? ` (${cell(finding.guide_ref)})` : ''}`),
        ...(entry.review.overlaps.length ? ['', 'Added lines sharing uncommon terms with train cases:', ...entry.review.overlaps.map(hit => `- "${cell(hit.line)}": ${hit.cases.map(item => `${cell(item.id)} (${item.terms.join(', ')})`).join('; ')}`)] : []), '');
    }
  }
  return lines;
}
