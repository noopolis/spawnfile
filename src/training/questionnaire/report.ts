import type { QuestionnaireResult } from './run.js';
import type { ScoredAnswer } from './types.js';

/**
 * Everything of a questionnaire result an optimizer may read: the open score, the gate over open
 * questions, and each failed open question with its text and the judge's reason. Hidden questions,
 * working steps, weights and the full score are absent by construction, not by filtering downstream.
 */
export interface QuestionnaireFeedback {
  status: 'pass' | 'fail' | 'error';
  score: number | null;
  failed: { id: string; question: string; answer: unknown; reason: string }[];
  /**
   * The ladder over open gate questions, present when the bank declares one: the open search score, the
   * failed rungs (lowest first, in declared order) and what the next rung needs. Hidden gates never appear.
   */
  ladder?: { search: number | null; failed: { id: string; count?: number }[]; next: string };
}

export function questionnaireFeedback(result: QuestionnaireResult): QuestionnaireFeedback {
  const open = result.answers.filter(answer => !answer.hidden);
  const gates = open.filter(answer => answer.gate);
  // An open question or its reason may name a working step or a hidden question; the name leaves as a placeholder.
  const secret = [...Object.values(result.scaffold).flatMap(steps => Object.keys(steps)), ...result.answers.filter(answer => answer.hidden).map(answer => answer.id)];
  const pattern = secret.length ? new RegExp(`(?<![\\w-])(?:${secret.map(id => id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})(?![\\w-])`, 'gu') : undefined;
  const redact = (text: string) => pattern ? text.replace(pattern, 'a withheld step') : text;
  const failedGates = gates.filter(answer => answer.status === 'ok' && !answer.passed);
  const rungs = new Map((result.rungs ?? []).map(rung => [rung.id, rung]));
  const openFactor = failedGates.reduce((product, answer) => product * (rungs.get(answer.id)?.factor ?? 1), 1);
  const lowest = failedGates[0];
  return {
    status: failedGates.length ? 'fail' : gates.some(answer => answer.status === 'error') ? 'error' : 'pass',
    score: result.scoreOpen,
    failed: open.filter(answer => answer.status === 'ok' && !answer.passed)
      .map(answer => ({ id: answer.id, question: redact(answer.ask), answer: answer.answer, reason: redact(answer.reason) })),
    ...(result.factor === null || result.factor === undefined ? {} : { ladder: {
      search: result.scoreOpen === null ? null : Math.round(result.scoreOpen * openFactor * 10_000) / 10_000,
      failed: failedGates.map(answer => ({ id: answer.id, ...(rungs.get(answer.id)?.count === undefined ? {} : { count: rungs.get(answer.id)!.count }) })),
      next: lowest ? `Clear gate ${lowest.id}${rungs.get(lowest.id)?.count ? ` (${rungs.get(lowest.id)!.count} found; each one costs)` : ''}: ${redact(lowest.ask)}`
        : 'Every open gate passes; raise the open questions that did not.',
    } }),
  };
}

export interface QuestionRate { id: string; hidden: boolean; gate: boolean; asked: number; passed: number; failed: number; na: number; errors: number; passRate: number | null; meanScore: number | null }

export interface QuestionnaireSummary {
  outputs: number;
  gatePassed: number;
  gateFailed: number;
  gateErrors: number;
  /** Share of outputs whose gate passed: the strict acceptance verdict. */
  acceptance: number | null;
  /** Mean graded search score over outputs. */
  search: number | null;
  /** Means over outputs; an output with no applicable question of a kind is left out of that mean. */
  score: number | null;
  scoreOpen: number | null;
  scoreHidden: number | null;
  /** Open minus hidden: how much better the candidate does on what the optimizer could see. */
  gap: number | null;
  questions: QuestionRate[];
}

const mean = (values: readonly (number | null)[]): number | null => {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? Math.round(known.reduce((sum, value) => sum + value, 0) / known.length * 10_000) / 10_000 : null;
};

/** Per-question pass rates, gate results and the open, hidden and full scores over one candidate's graded outputs. */
export function summarizeQuestionnaire(results: readonly QuestionnaireResult[]): QuestionnaireSummary {
  const byId = new Map<string, ScoredAnswer[]>();
  for (const result of results) for (const answer of result.answers) byId.set(answer.id, [...byId.get(answer.id) ?? [], answer]);
  const scoreOpen = mean(results.map(result => result.scoreOpen));
  const scoreHidden = mean(results.map(result => result.scoreHidden));
  return {
    outputs: results.length,
    gatePassed: results.filter(result => result.gate === 'pass').length,
    gateFailed: results.filter(result => result.gate === 'fail').length,
    gateErrors: results.filter(result => result.gate === 'error').length,
    acceptance: results.length ? Math.round(results.filter(result => result.gate === 'pass').length / results.length * 10_000) / 10_000 : null,
    search: mean(results.map(result => result.search ?? null)),
    score: mean(results.map(result => result.score)), scoreOpen, scoreHidden,
    gap: scoreOpen === null || scoreHidden === null ? null : Math.round((scoreOpen - scoreHidden) * 10_000) / 10_000,
    questions: [...byId].map(([id, answers]) => {
      const ok = answers.filter(answer => answer.status === 'ok');
      const passed = ok.filter(answer => answer.passed).length;
      return { id, hidden: answers[0]!.hidden, gate: answers[0]!.gate, asked: answers.length, passed, failed: ok.length - passed,
        na: answers.filter(answer => answer.status === 'na').length, errors: answers.filter(answer => answer.status === 'error').length,
        passRate: ok.length ? Math.round(passed / ok.length * 10_000) / 10_000 : null, meanScore: mean(ok.map(answer => answer.score)) };
    }),
  };
}
