/** Interim, runtime-neutral integration surface; stable within 0.1.x. */
export type { ArtifactSnapshot, Dataset, TrainingConfiguration, TrialSlot } from './contracts/index.js';
export type { CandidateManifest, EditPolicy } from './candidates/index.js';
export type { NativePreparationContext, TrialOutcome, TrialPaths } from './experiments/index.js';
export { runTrial, loadTrialSlots, trainingFeedback } from './experiments/index.js';
export { parseDatasetYaml, resolveDataset } from './cases/index.js';
export { createEvaluationRegistry, evaluatePlan } from './evaluation/index.js';
export { assertModelRequestAdmission, budgetEvaluatorInference, typeSafeEvaluatorEnvironment } from './inference/index.js';
export { bridgeExecutionIdentity } from './optimization/index.js';
export { openExperimentStore } from './storage/index.js';
