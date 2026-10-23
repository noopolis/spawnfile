/** Selected CLI integration exports; runtime composition stays outside the core. */
export {
  launch, trainingDependencies, spawnfileEnvironment, CliDatasets, createTrainingInference,
} from './trainingCli.js';
export type {
  CliExecutionIdentityContext, SpawnfileCliIntegration, SpawnfileTrainingContext,
  TrainingMomentCase, TrainingMomentPreparation,
} from './trainingCli.js';
