import { commandCheckpoint as checkpoint } from '../../../src/training/cli/training/checkpoint.js';
import { createTrainingProviderRegistry } from '../../../src/runtime/trainingProviders.js';
import * as cases from '../../../src/training/cases/index.js';
import * as inference from '../../../src/training/cli/training/inference.js';
import * as configuration from '../../../src/training/cli/training/configuration.js';
import * as optimizer from '../../../src/training/cli/training/optimizer.js';
import * as policies from '../../../src/training/providers/index.js';
import type { InferenceProviderRegistry } from '../../../src/training/contracts/index.js';

export { createGrokInference } from '../../../src/runtime/daimon/training/providers/grok-subscription/index.js';
export { createCodexInference } from '../../../src/runtime/codex-exec/training/providers/codex-subscription/index.js';
export type { GrokInferenceGrantAuthority } from '../../../src/runtime/daimon/training/providers/grok-broker/grants.js';

export const providers = createTrainingProviderRegistry();
export const parseDatasetYaml: typeof cases.parseDatasetYaml = (source, options = {}) => cases.parseDatasetYaml(source, { inferenceProviders: providers, ...options });
export const resolveDataset: typeof cases.resolveDataset = (document, options = {}) => cases.resolveDataset(document, { inferenceProviders: providers, ...options });
export const resolveDatasetForCost: typeof cases.resolveDatasetForCost = (document, options = {}) => cases.resolveDatasetForCost(document, { inferenceProviders: providers, ...options });
export const validateTrainingConfiguration: typeof cases.validateTrainingConfiguration = (value, path, registry = providers) => cases.validateTrainingConfiguration(value, path, registry);
export const trainingJudgeVersions: typeof cases.trainingJudgeVersions = (config, identity, names, registry = providers) => cases.trainingJudgeVersions(config, identity, names, registry);
export const judgeVersions = trainingJudgeVersions;
export const authoredArguments: typeof configuration.authoredArguments = (args, io, registry = providers) => configuration.authoredArguments(args, io, registry);
export const resolveTrainingOptimizer: typeof optimizer.resolveTrainingOptimizer = (args, integration, context, registry = providers) => optimizer.resolveTrainingOptimizer(args, integration, context, registry);
export const trainingRoutePolicies: typeof policies.trainingRoutePolicies = (config, route, identity, registry = providers) => policies.trainingRoutePolicies(config, route, identity, registry);
export const trainingInferencePolicies: typeof policies.trainingInferencePolicies = (config, identity, registry = providers) => policies.trainingInferencePolicies(config, identity, registry);
export const createTrainingInference: typeof inference.createTrainingInference = (args, dependencies, timeout, judges, repairs) => inference.createTrainingInference(args,
  { ...dependencies, inferenceProviders: dependencies.inferenceProviders ?? createTrainingProviderRegistry(dependencies) }, timeout, judges, repairs);
export type { InferenceProviderRegistry };

export const commandCheckpoint: typeof checkpoint = (args, inputs, dependencies, context, repair) => checkpoint(args, inputs, { ...dependencies, inferenceProviders: dependencies.inferenceProviders ?? createTrainingProviderRegistry(dependencies) }, context, repair);
