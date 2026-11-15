import type { CriticReview } from './review.js';

export interface CriticGateEntry { candidateId: string; validationScore: number | null; review: CriticReview; selected: boolean }
export interface CriticGateReport {
  /** Every reviewed candidate in the order it was considered, best validation score first. */
  reviews: CriticGateEntry[];
  selectedId: string;
  /** The candidate the search selected, when the critic removed it. */
  displacedId?: string;
}

/**
 * The critic gate over a finished search: candidates are considered from the best validation score down,
 * and the first one whose review passes is selected. A blocked or unreviewable candidate is removed from
 * selection. The baseline is the reference, is never reviewed and always remains selectable.
 */
export async function selectThroughCritic<T extends { id: string }>(options: {
  baseline: T;
  /** The search's own choice first; ties keep the given order. */
  ranked: readonly { candidate: T; validationScore: number | null }[];
  review: (candidate: T) => Promise<CriticReview>;
}): Promise<{ selected: T; report: CriticGateReport }> {
  const reviews: CriticGateEntry[] = [];
  const seen = new Set<string>();
  const first = options.ranked[0]?.candidate.id ?? options.baseline.id;
  let selected = options.baseline;
  for (const entry of options.ranked) {
    if (seen.has(entry.candidate.id)) continue;
    seen.add(entry.candidate.id);
    if (entry.candidate.id === options.baseline.id) break;
    const review = await options.review(entry.candidate);
    const passed = review.verdict === 'pass';
    reviews.push({ candidateId: entry.candidate.id, validationScore: entry.validationScore, review, selected: passed });
    if (passed) { selected = entry.candidate; break; }
  }
  return { selected, report: { reviews, selectedId: selected.id, ...(selected.id === first ? {} : { displacedId: first }) } };
}
