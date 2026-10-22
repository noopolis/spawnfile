import type { ViewerData } from '../types.js';
import { indexCandidates } from './candidates.js';
import { summarizeScores } from './scores.js';
import { summarizeRecordedCosts } from './recorded-costs.js';
import type { CockpitMetrics } from './types.js';

/** Pure presentation over an already authorized and sanitized projection. */
export function buildCockpitMetrics(data: ViewerData): CockpitMetrics {
  const index = indexCandidates(data);
  const trialIndex = data.trials.map(trial => ({ id: trial.id, candidateId: index.resolve(trial.candidateId), split: index.split(trial.caseId) }));
  return { candidates: index.groups, ...summarizeScores(data, index), costs: summarizeRecordedCosts(data),
    trialIndex, unknownCaseTrials: trialIndex.filter(trial => trial.split === 'unknown').length };
}
