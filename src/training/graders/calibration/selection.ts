import { applyPlatt, fitQuestion } from './fitting.js';
import type { CalibrationRecord, PlattParams } from './types.js';

export interface ModelFitRows {
  id: string;
  teacher: boolean;
  fit: readonly CalibrationRecord[];
}

/** Calibrated mean binary NLL, with the entire golden fit denominator retained.
 * A missing answer has maximum binary error, as in held-out metrics: truth
 * probability zero, clipped to 1e-6 for finite NLL. Never impute p(good)=0.
 */
export function fitNll(rows: readonly CalibrationRecord[], params: PlattParams): number {
  if (!rows.length) return Infinity;
  return rows.reduce((sum, row) => {
    const p = row.missing ? 0 : applyPlatt(row.rawPGood, params);
    const truth = row.missing ? 0 : row.good ? p : 1 - p;
    return sum - Math.log(Math.max(1e-6, Math.min(1 - 1e-6, truth)));
  }, 0) / rows.length;
}

/** Strict improvement preserves authored order on ties, including no fit evidence. */
export function selectQuestionModel(questionId: string, type: CalibrationRecord['type'], candidates: readonly ModelFitRows[]): string {
  if (!candidates.length) throw new Error('Model selection requires candidates');
  let selected = candidates[0]!.id, lowest = Infinity;
  for (const candidate of candidates) {
    const fit = fitQuestion(candidate.fit, questionId, type);
    const loss = fitNll(fit.questionSplit, candidate.teacher ? { a: 1, b: 0 } : fit.params);
    if (loss < lowest) { selected = candidate.id; lowest = loss; }
  }
  return selected;
}
