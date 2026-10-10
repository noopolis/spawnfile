import { inferenceFailureDetails, type InferenceFailureDetail } from '../../contracts/execution.js';
import type { JudgeCall, JudgeFailure, JudgeFailureCause, JudgeProtocolViolation } from '../../contracts/evaluation.js';
import { inferenceFailureKind } from './attempts.js';

/** A judge-side failure whose cause the judge itself already knows; never classified from its message. */
export class JudgeEvaluationError extends Error {
  constructor(readonly judgeCause: JudgeFailureCause, message: string) {
    super(message);
    this.name = 'JudgeEvaluationError';
  }
}

/** Only the trusted provider's typed refinement; a refused grant is not read out of prose. */
function failureDetail(error: unknown): InferenceFailureDetail | undefined {
  if (!(error instanceof Error) || !('detail' in error)) return undefined;
  return inferenceFailureDetails.includes(error.detail as never) ? error.detail as InferenceFailureDetail : undefined;
}

/** Only a provider-reported response status, and only as a safe integer. */
function failureStatus(error: unknown): number | undefined {
  if (!(error instanceof Error) || !('status' in error)) return undefined;
  return Number.isSafeInteger(error.status) && (error.status as number) > 0 ? error.status as number : undefined;
}

/**
 * The provider's typed discriminators decide the cause. `kind` alone cannot tell
 * a refused grant from an expired one from a broker that is down, so the closed
 * refinement wins when the adapter set one; nothing here reads an error message.
 */
export function inferenceJudgeCause(error: unknown): JudgeFailureCause {
  const detail = failureDetail(error);
  if (detail === 'grant-refused') return 'grant-refused';
  if (detail === 'grant-expired') return 'grant-expired';
  const kind = inferenceFailureKind(error);
  if (kind === 'cancelled') return 'cancelled';
  if (kind === 'timeout') return 'timeout';
  if (kind === 'invalid-response') return 'response-schema';
  if (kind === 'auth-stale') return 'grant-expired';
  if (kind === undefined || kind === 'unknown') return 'unclassified';
  return 'provider-error';
}

/** A response the judge could read but could not use; the violation code is already closed. */
export function violationJudgeCause(violation: JudgeProtocolViolation): JudgeFailureCause {
  if (violation.code === 'invalid-json') return 'response-unparseable';
  if (violation.code === 'invalid-citations') return 'response-citations';
  return 'response-schema';
}

export interface JudgeIdentity {
  judge: string;
  requestedModel: string | null;
  /** The most recent actual attempt, when one was made. */
  call?: JudgeCall;
}

/**
 * Publishes the cause with the identity that answered, and nothing else.
 *
 * Every field is either a closed vocabulary value, a number, or an identity the
 * route or the provider already publishes on a `JudgeCall`. No prompt, subject
 * text, response body, bearer or grant token has a field to travel in.
 */
export function judgeFailure(cause: JudgeFailureCause, identity: JudgeIdentity, error?: unknown): JudgeFailure {
  const call = identity.call;
  const status = cause === 'provider-error' ? failureStatus(error) : undefined;
  const kind = call?.failureKind ?? inferenceFailureKind(error);
  return { cause, judge: identity.judge,
    providerId: call?.providerId ?? null,
    requestedModel: call?.requestedModel ?? identity.requestedModel,
    responseModel: call?.responseModel ?? null,
    responseRoute: call?.responseRoute ?? null,
    ...(kind === undefined ? {} : { kind }),
    ...(status === undefined ? {} : { status }) };
}

/** The one classifier for anything thrown out of a judge attempt. */
export function thrownJudgeCause(error: unknown): JudgeFailureCause {
  return error instanceof JudgeEvaluationError ? error.judgeCause : inferenceJudgeCause(error);
}
