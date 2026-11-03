/** Selected CLI integration exports; runtime composition stays outside the core. */
export {
  launch, trainingDependencies, CliDatasets, createTrainingInference,
} from './trainingCli.js';
export type {
  CliExecutionIdentityContext, SpawnfileCliIntegration, SpawnfileTrainingContext,
} from './trainingCli.js';
