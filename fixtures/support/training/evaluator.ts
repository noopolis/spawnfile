import { createTrainingProviderRegistry } from '../../../src/runtime/trainingProviders.js';
import * as policy from '../../../src/training/inference/evaluator/policy.js';
import * as ledger from '../../../src/training/inference/evaluator/ledger.js';
import * as provider from '../../../src/training/inference/evaluator/provider.js';
import * as cap from '../../../src/training/inference/request-cap.js';
import * as decision from '../../../src/training/inference/decision/index.js';

const registry = createTrainingProviderRegistry();
export type { EvaluatorRoute } from '../../../src/training/inference/evaluator/policy.js';
export { readProtectedFile } from '../../../src/training/inference/evaluator/policy.js';
export { typeSafeEvaluatorEnvironment } from '../../../src/training/inference/evaluator/provider.js';
export const evaluatorPolicy: typeof policy.evaluatorPolicy = (providers = registry) => policy.evaluatorPolicy(providers);
export const evaluatorRoute: typeof policy.evaluatorRoute = (name, purpose, model, providers = registry) => policy.evaluatorRoute(name, purpose, model, providers);
export const reserveEvaluatorRequest: typeof ledger.reserveEvaluatorRequest = (name, purpose, model, usd, providers = registry) => ledger.reserveEvaluatorRequest(name, purpose, model, usd, providers);
export const budgetEvaluatorInference: typeof provider.budgetEvaluatorInference = (instance, name, purpose, model, providers = registry) => provider.budgetEvaluatorInference(instance, name, purpose, model, providers);
export const assertModelRequestAdmission: typeof cap.assertModelRequestAdmission = (name, route, purpose, providers = registry) => cap.assertModelRequestAdmission(name, route, purpose, providers);
export const createTypeSafeDecision: typeof decision.createTypeSafeDecision = options => decision.createTypeSafeDecision({ ...options, inferenceProviders: options.inferenceProviders ?? registry });
