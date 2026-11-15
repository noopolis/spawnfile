import type { QuestionnaireSummary } from './report.js';

const cell = (value: unknown): string => String(value).replace(/\|/gu, '&#124;').replace(/[\r\n]+/gu, ' ');
const number = (value: number | null): string => value === null ? 'n/a' : value.toFixed(3);
const table = (head: readonly string[], rows: readonly unknown[][]): string => [head, head.map(() => '---'), ...rows]
  .map(row => `| ${row.map(cell).join(' | ')} |`).join('\n');

/** Scores a report may override per candidate, for example to count missing outputs as zero. */
export interface QuestionnaireCandidateRow { summary: QuestionnaireSummary; score?: number | null; scoreOpen?: number | null; scoreHidden?: number | null; gap?: number | null; missing?: number }

/**
 * The operator's view of a questionnaire across candidates: gate results, the full, open and hidden
 * scores with their gap, then every question's pass rate per candidate. Operator-only: it names hidden questions.
 */
export function renderQuestionnaireMarkdown(candidates: Readonly<Record<string, QuestionnaireCandidateRow>>): string {
  const labels = Object.keys(candidates);
  const questions = new Map<string, { hidden: boolean; gate: boolean }>();
  for (const { summary } of Object.values(candidates)) for (const question of summary.questions) questions.set(question.id, question);
  const rate = (label: string, id: string): string => {
    const question = candidates[label]!.summary.questions.find(entry => entry.id === id);
    if (!question) return 'n/a';
    return `${number(question.passRate)}${question.errors ? ` (${question.errors} errors)` : ''}`;
  };
  return [
    table(['Candidate', 'Outputs', 'Missing', 'Gate pass', 'Gate fail', 'Gate error', 'All questions', 'Open', 'Hidden', 'Open minus hidden'],
      labels.map(label => {
        const row = candidates[label]!, summary = row.summary;
        return [label, summary.outputs + (row.missing ?? 0), row.missing ?? 0, summary.gatePassed, summary.gateFailed, summary.gateErrors,
          number(row.score === undefined ? summary.score : row.score), number(row.scoreOpen === undefined ? summary.scoreOpen : row.scoreOpen),
          number(row.scoreHidden === undefined ? summary.scoreHidden : row.scoreHidden), number(row.gap === undefined ? summary.gap : row.gap)];
      })),
    '',
    table(['Question', 'Hidden', 'Gate', ...labels], [...questions].map(([id, question]) =>
      [id, question.hidden ? 'yes' : '', question.gate ? 'yes' : '', ...labels.map(label => rate(label, id))])),
  ].join('\n');
}
