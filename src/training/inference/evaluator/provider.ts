import type { InferenceProvider } from '../../contracts/execution.js';
import { evaluatorRoute, readProtectedFile, type EvaluatorPurpose } from './policy.js';
import { reserveEvaluatorRequest } from './ledger.js';

export function budgetEvaluatorInference(provider: InferenceProvider, name: string, purpose: EvaluatorPurpose, model: string): InferenceProvider {
  if (name === 'grok-broker' || process.env.PAIDEIA_MODEL_REQUEST_CAP !== 'broker' && process.env.PAIDEIA_EVALUATOR_ROUTES_FILE === undefined) return provider;
  evaluatorRoute(name, purpose, model);
  return { ...provider, async generate(request) {
    if (request.model !== model) throw Error('Evaluator request model differs from declared model');
    request.signal?.throwIfAborted();
    const admission = reserveEvaluatorRequest(name, purpose, model);
    let settled = false;
    try {
      const result = await provider.generate(request);
      settled = true;
      admission.finish('completed', result.usage ?? undefined);
      return result;
    } catch (error) {
      if (!settled) {
        const usage = error !== null && typeof error === 'object' && 'usage' in error ? error.usage : undefined;
        admission.finish('failed', usage && typeof usage === 'object' ? usage : undefined);
      }
      throw error;
    }
  } };
}
/** The leaf becomes an evaluator transport-local environment, never process.env. */
export function typeSafeEvaluatorEnvironment(): Readonly<Record<string, string | undefined>> | undefined {
  const file = process.env.PAIDEIA_TYPESAFE_SECRET_FILE;
  if (!file) return undefined;
  try {
    const key = readProtectedFile(file, 16 * 1024).trim();
    if (!key || /[\r\n\0]/u.test(key)) throw Error('invalid');
    return { TYPESAFE_API_KEY: key };
  } catch { throw Error('Invalid evaluator TypeSafe secret file'); }
}
