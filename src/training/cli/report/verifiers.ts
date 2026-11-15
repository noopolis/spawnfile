import type { CriticGateReport } from '../../critic/index.js';
import type { RescoreReport, TrainingReport, TrialReport } from '../../experiments/index.js';
import { renderQuestionnaireMarkdown, summarizeQuestionnaire, type QuestionnaireResult, type QuestionnaireSummary } from '../../questionnaire/index.js';

type Split = 'train' | 'validation' | 'test';
export interface VerifierSummary {
  /** Per questionnaire check, per split, per candidate label: pass rates, gates and the open, hidden and full scores. */
  questionnaires: Record<string, Partial<Record<Split, Record<string, QuestionnaireSummary>>>>;
  /** Critic reviews behind the frozen selection, with candidate labels. */
  critic: (Omit<CriticGateReport, 'reviews'> & { reviews: (CriticGateReport['reviews'][number] & { label: string })[] }) | null;
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
    reviews: report.critic.reviews.map(entry => ({ ...entry, label: labels.get(entry.candidateId) ?? entry.candidateId })) } : null };
}

const cell = (value: unknown) => String(value).replace(/\|/gu, '&#124;').replace(/[\r\n]+/gu, ' ');

export function renderVerifiersMarkdown(summary: VerifierSummary): string[] {
  const lines: string[] = [];
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
