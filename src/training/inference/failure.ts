import type { InferenceAttempt, InferenceFailureKind, Usage } from '../contracts/execution.js';

export interface InferenceFailureEvidence {
  usage?: Usage | null;
  responseModel?: string | null;
  responseRoute?: string | null;
  attempts?: readonly InferenceAttempt[];
}

/** Adapters classify native evidence; routing never guesses from arbitrary error text. */
export class InferenceFailure extends Error {
  readonly kind: InferenceFailureKind;
  readonly usage: Usage | null;
  readonly responseModel: string | null;
  readonly responseRoute: string | null;
  readonly attempts: readonly InferenceAttempt[];

  constructor(kind: InferenceFailureKind, message: string, evidence: InferenceFailureEvidence = {}) {
    super(message);
    this.name = 'InferenceFailure';
    this.kind = kind;
    this.usage = evidence.usage == null ? null : Object.freeze(structuredClone(evidence.usage));
    this.responseModel = evidence.responseModel ?? null;
    this.responseRoute = evidence.responseRoute ?? null;
    this.attempts = immutableAttempts(evidence.attempts ?? []);
  }
}

export function immutableAttempts(attempts: readonly InferenceAttempt[]): readonly InferenceAttempt[] {
  return Object.freeze(attempts.map(attempt => Object.freeze({ ...attempt,
    usage: attempt.usage === null ? null : Object.freeze(structuredClone(attempt.usage)),
  })));
}
