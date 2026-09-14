import type { JudgeCall } from '../../contracts/evaluation.js';
import type { InferenceAttempt } from '../../contracts/execution.js';

/** Expand transport attempts into actual calls so retries cannot disappear from costs. */
export function routedJudgeCalls(base: JudgeCall, attempts: readonly InferenceAttempt[]): JudgeCall[] {
  return attempts.map((attempt, index) => ({
    ...base, id: attempt.id, providerId: attempt.providerId,
    requestedModel: attempt.requestedModel, responseModel: attempt.responseModel,
    responseRoute: attempt.responseRoute, usage: structuredClone(attempt.usage),
    outcome: attempt.outcome === 'failed' ? 'generation-error' : base.outcome,
    ...(attempt.failureKind ? { failureKind: attempt.failureKind } : {}),
    ...(index ? { fallbackOf: attempts[0]!.id } : {}),
  }));
}

/** The provider is a trusted host boundary; only its typed metadata is projected. */
export function failedInferenceAttempts(error: unknown): readonly InferenceAttempt[] {
  if (!(error instanceof Error) || !('attempts' in error) || !Array.isArray(error.attempts)) return [];
  return error.attempts as InferenceAttempt[];
}
