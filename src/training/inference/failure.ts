import type { InferenceAttempt, InferenceFailureDetail, InferenceFailureKind, InferenceDiagnostic, Usage } from '../contracts/execution.js';

export interface InferenceFailureEvidence {
  /** A closed refinement of `kind`, set only by the adapter that observed the distinction. */
  detail?: InferenceFailureDetail | null;
  /** A provider-reported response status, retained as a number so no prose has to be parsed back. */
  status?: number | null;
  usage?: Usage | null;
  responseModel?: string | null;
  responseRoute?: string | null;
  attempts?: readonly InferenceAttempt[];
  diagnostic?: InferenceDiagnostic;
}

/** Adapters classify native evidence; routing never guesses from arbitrary error text. */
export class InferenceFailure extends Error {
  readonly kind: InferenceFailureKind;
  readonly detail: InferenceFailureDetail | null;
  readonly status: number | null;
  readonly usage: Usage | null;
  readonly responseModel: string | null;
  readonly responseRoute: string | null;
  readonly attempts: readonly InferenceAttempt[];
  #diagnostic?: InferenceDiagnostic;
  /** Prototype getter keeps protected text out of JSON.stringify/spread of errors. */
  get diagnostic(): InferenceDiagnostic | undefined { return this.#diagnostic; }

  constructor(kind: InferenceFailureKind, message: string, evidence: InferenceFailureEvidence = {}) {
    super(message);
    this.name = 'InferenceFailure';
    this.kind = kind;
    this.detail = evidence.detail ?? null;
    this.status = Number.isSafeInteger(evidence.status) ? evidence.status! : null;
    if (evidence.diagnostic) {
      const diagnostic = structuredClone(evidence.diagnostic);
      if (diagnostic.response) Object.freeze(diagnostic.response);
      this.#diagnostic = Object.freeze(diagnostic);
    }
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
