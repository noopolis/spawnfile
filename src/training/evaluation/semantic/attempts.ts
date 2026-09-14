import type { JudgeCall } from '../../contracts/evaluation.js';
import type { InferenceAttempt, InferenceFailureKind, Usage } from '../../contracts/execution.js';

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

/** Only a trusted provider's typed discriminator; never infer policy from prose. */
export function inferenceFailureKind(error: unknown): InferenceFailureKind | undefined {
  if (!(error instanceof Error) || !('kind' in error)) return undefined;
  const kinds: readonly unknown[] = ['quota', 'transport', 'unavailable', 'authentication',
    'protocol', 'cancelled', 'timeout', 'unsupported', 'unknown'];
  return kinds.includes(error.kind) ? error.kind as InferenceFailureKind : undefined;
}

/** Validate and project only named accounting fields from a typed direct failure. */
export function directFailureEvidence(error: unknown): Partial<JudgeCall> {
  const failureKind = inferenceFailureKind(error);
  if (!failureKind) return {};
  const value = error as Error & Record<string, unknown>;
  const text = (field: string) => typeof value[field] === 'string' && value[field].trim() ? value[field] : null;
  const raw = value.usage;
  let usage: Usage | null = null;
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'source' in raw && typeof raw.source === 'string' && raw.source.trim()) {
    const counts = raw as Record<string, unknown>;
    const count = (field: string): number | null => typeof counts[field] === 'number' && Number.isSafeInteger(counts[field]) && counts[field] >= 0 ? counts[field] : null;
    usage = { inputTokens: count('inputTokens'), cachedInputTokens: count('cachedInputTokens'),
      outputTokens: count('outputTokens'), reasoningTokens: count('reasoningTokens'), source: raw.source };
    for (const field of ['cacheWriteInputTokens', 'cacheWrite5mInputTokens', 'cacheWrite1hInputTokens'] as const) {
      if (Object.hasOwn(counts, field)) usage[field] = count(field);
    }
  }
  return { failureKind, responseModel: text('responseModel'), responseRoute: text('responseRoute'), usage };
}
