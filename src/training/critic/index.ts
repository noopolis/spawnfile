export { caseOverlaps, changedLines, terms, type CaseOverlap } from './overlap.js';
export { CRITIC_PROMPT_VERSION, criticCategories, criticSchema, criticSeverities, criticSystem, renderCriticPrompt, reviewCandidate,
  type CriticFinding, type CriticInput, type CriticReview, type CriticSeverity } from './review.js';
export { selectThroughCritic, type CriticGateEntry, type CriticGateReport } from './gate.js';
export { criticIdentity, criticSelection, describeChecks, rankedCandidates, trainCaseTexts, type RankedCandidate, type TrainingCriticOptions } from './selection.js';
