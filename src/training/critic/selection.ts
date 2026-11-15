import { createHash } from 'node:crypto';
import { candidateComponents, type CandidateManifest } from '../candidates/index.js';
import type { CheckNode, ResolvedDataset } from '../contracts/dataset.js';
import type { JudgeRoute } from '../contracts/evaluation.js';
import type { DspyResult } from '../optimization/index.js';
import { selectThroughCritic, type CriticGateReport } from './gate.js';
import { CRITIC_PROMPT_VERSION, reviewCandidate, type CriticReview, type CriticSeverity } from './review.js';

/** The run's critic: a named judge route, the house documents and what else the critic is shown. */
export interface TrainingCriticOptions {
  judge: Pick<JudgeRoute, 'provider' | 'model'> & { name: string };
  guide: readonly { name: string; text: string }[];
  show: { checks: boolean; trainTasks: boolean };
  blockOn: CriticSeverity;
}

const text = (candidate: CandidateManifest): Record<string, string> =>
  Object.fromEntries(candidateComponents(candidate).map(component => [component.id, component.text]));

/** Declared checks as the critic may see them: ids, evaluators and mechanical parameters; judged question text stays withheld. */
export function describeChecks(dataset: ResolvedDataset): string {
  const lines = new Set<string>();
  const visit = (check: CheckNode) => {
    if (check.eval) {
      const { id, eval: evaluator, ...parameters } = check;
      const judged = ['grader', 'questionnaire', 'llm-rubric'].includes(evaluator);
      const shown = Object.entries(parameters).filter(([key]) => !['input', 'source', 'schema', 'context'].includes(key));
      lines.add(`- ${id ?? evaluator}: ${evaluator}${judged ? ' (a model answers fixed questions about the output; question text is withheld)'
        : shown.length ? ` ${shown.map(([key, value]) => `${key} ${JSON.stringify(value)}`).join(', ')}` : ''}`);
    }
    [...check.all ?? [], ...check.any ?? [], ...check.not ? [check.not] : []].forEach(visit);
  };
  for (const record of dataset.records) for (const stage of record.effectiveStages) stage.checks.forEach(visit);
  return [...lines].join('\n');
}

/** Train case texts only: the task each train record gave the subject. */
export function trainCaseTexts(train: ResolvedDataset): { id: string; text: string }[] {
  return train.records.map(record => {
    const prompt = (record.input as { prompt?: unknown } | undefined)?.prompt;
    return { id: record.id, text: typeof prompt === 'string' ? prompt : JSON.stringify(record.input ?? record.turns ?? null) };
  });
}

export interface RankedCandidate { candidate: CandidateManifest; validationScore: number | null }

/** The search's candidates in selection order: its own choice first, then best validation score first. */
export function rankedCandidates(optimizer: DspyResult, candidateFor: (components: Readonly<Record<string, string>>) => CandidateManifest): RankedCandidate[] {
  const ranked = optimizer.provenance.candidates.map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.validationScore - a.entry.validationScore || a.index - b.index)
    .map(({ entry }) => ({ candidate: candidateFor(entry.components), validationScore: entry.validationScore }));
  return [{ candidate: candidateFor(optimizer.components), validationScore: ranked[0]?.validationScore ?? null }, ...ranked];
}

/** What a review depends on besides the candidate: a kept review is reused only under the same identity. */
export function criticIdentity(critic: TrainingCriticOptions, baseline: CandidateManifest, train: ResolvedDataset): string {
  return createHash('sha256').update(JSON.stringify([CRITIC_PROMPT_VERSION, critic.judge.name, critic.judge.model, critic.blockOn, critic.show,
    critic.guide.map(document => [document.name, document.text]), text(baseline),
    critic.show.checks ? describeChecks(train) : null, critic.show.trainTasks ? trainCaseTexts(train) : null])).digest('hex');
}

/**
 * The critic gate between a finished search and frozen selection. Candidates are taken from the search's
 * own provenance, best validation score first (the search's rule), so the first candidate considered is
 * the one the search selected; reviews see train cases only. A review kept from an earlier pass of the same
 * run is reused, never asked again.
 */
export async function criticSelection(options: {
  critic: TrainingCriticOptions; baseline: CandidateManifest; train: ResolvedDataset; optimizer: DspyResult;
  candidateFor: (components: Readonly<Record<string, string>>) => CandidateManifest; signal?: AbortSignal;
  /** Candidates in selection order, when the caller already removed some; the search's own order otherwise. */
  ranked?: readonly RankedCandidate[];
  /** Usable reviews of an earlier pass, by candidate id. */
  reviewed?: Readonly<Record<string, CriticReview>>;
  onReview?: (candidateId: string, review: CriticReview, restored: boolean) => void | Promise<void>;
}): Promise<{ selected: CandidateManifest; report: CriticGateReport }> {
  const { critic } = options;
  const baseline = text(options.baseline);
  return selectThroughCritic({ baseline: options.baseline, ranked: options.ranked ?? rankedCandidates(options.optimizer, options.candidateFor),
    review: async candidate => {
      const kept = options.reviewed && Object.hasOwn(options.reviewed, candidate.id) ? options.reviewed[candidate.id] : undefined;
      const review = kept ?? await reviewCandidate({ baseline, candidate: text(candidate), guide: critic.guide, judge: critic.judge, blockOn: critic.blockOn, signal: options.signal,
        ...(critic.show.checks ? { checks: describeChecks(options.train) } : {}),
        ...(critic.show.trainTasks ? { trainCases: trainCaseTexts(options.train) } : {}) });
      await options.onReview?.(candidate.id, review, kept !== undefined);
      return review;
    } });
}
