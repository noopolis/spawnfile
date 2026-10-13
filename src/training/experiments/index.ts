export { runTrial } from './trials/index.js';
export type { TrialOptions, TrialReport, TrialPaths, PreparedTrial, TrialEvent } from './trials/index.js';
export { runStoredTrial, type StoredTrialOptions, type NativePreparationContext } from './trials/index.js';
export { subjectStartupCapture, subjectStartupDiagnostic, writeOperatorCapture } from './trials/index.js';
export { trainAgent, type TrainingOptions, type TrainingReport } from './training/index.js';
export { partitionTraining } from './training/index.js';
export { trialScore } from './training/index.js';
export { freezeCriteria } from './training/index.js';
export { rescoreStoredTrial, type RescoreOptions, type RescoreReport } from './replay/index.js';
export * from './costs/index.js';

export { compareCandidates, type ComparisonOptions, type ComparisonReport } from "./comparison/index.js";

export { loadTrialSlots, trialConcurrency, SlotPool, type SlotLease, type TrialSlot } from './concurrency/index.js';
