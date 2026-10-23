import { trainingEnvironment } from '../platform/index.js';
import { evaluatorRoute, type EvaluatorPurpose } from './evaluator/index.js';

/** Subject requests remain broker-owned; evaluator admission pins purpose and model. */
export function assertModelRequestAdmission(provider: string, route: string,
  evaluator?: { purpose: EvaluatorPurpose; model: string }): void {
  const policy = trainingEnvironment('SPAWNFILE_TRAINING_MODEL_REQUEST_CAP');
  if (policy === undefined) {
    if (evaluator && trainingEnvironment('SPAWNFILE_TRAINING_EVALUATOR_ROUTES_FILE') !== undefined) evaluatorRoute(provider, evaluator.purpose, evaluator.model);
    return;
  }
  if (policy !== 'broker') throw new Error('Unsupported SPAWNFILE_TRAINING_MODEL_REQUEST_CAP policy');
  if (provider === 'grok-broker') return;
  if (evaluator) { evaluatorRoute(provider, evaluator.purpose, evaluator.model); return; }
  throw new Error(`Capped training requires grok-broker admission; ${route} uses unsupported ${provider}`);
}
