/**
 * Diagnostics and convergence budget for the organization handoff filesystem
 * authority.
 *
 * This module is deliberately dependency-free: the authority worker is forked
 * as a standalone process whose only other imports are `node:fs`, and that
 * minimal surface is part of its threat model.
 *
 * ## Why a wall-clock budget
 *
 * Concurrent publishers converge by waiting for a peer to finish writing and
 * linking a record. That is a wall-clock event — it completes when the peer is
 * scheduled and its I/O lands. An attempt-counted budget answers a different
 * question ("have I looked N times?") whose relationship to elapsed time is set
 * by machine load, so the effective patience of the loop drifts with the very
 * contention it exists to absorb. The budget below is therefore primarily a
 * deadline; the attempt cap is only a secondary guard against a pathological
 * hot loop if a timer or clock misbehaves.
 *
 * ## Why one budget per request
 *
 * The convergence loops nest (write -> settle -> read-staging -> read). Giving
 * each loop its own budget bounds no level usefully: each individual loop is
 * too impatient while their product is effectively unbounded. A single budget
 * threaded through one request bounds the thing that actually has a deadline —
 * the request — and is what the client's own request deadline must exceed.
 */

/** Uniform public failure message. Detail is appended, never substituted. */
export const ORGANIZATION_HANDOFF_AUTHORITY_ERROR = "Organization handoff authority failed";

/** Wall-clock convergence budget for one authority request. */
export const PUBLICATION_BUDGET_MS = 2_000;
/**
 * Secondary bound only. It is far above the attempt count any healthy
 * convergence needs; it exists so a broken timer cannot spin forever.
 */
export const PUBLICATION_MAX_ATTEMPTS = 4_096;
/**
 * Fraction of the budget spent waiting for a peer before a proven, incomplete
 * staging prefix is retired instead. Patience must expire strictly before the
 * budget does, or the recovery path could never run.
 */
export const PUBLICATION_PATIENCE_FRACTION = 0.5;

const BASE_WAIT_MS = 1;
const MAX_WAIT_MS = 25;
const MAX_CODE_LENGTH = 64;
const MAX_STATE_LENGTH = 240;

/**
 * Structural diagnostics for a failed authority request.
 *
 * `state` describes the *shape* of the contending filesystem state — sidecar
 * presence, link counts, sizes. It never carries record bytes, leaf names, or
 * paths: this is the secret-publication path, and the diagnostic must not
 * become a disclosure channel.
 */
export interface OrganizationHandoffAuthorityFailureDetail {
  readonly attempts?: number;
  readonly budget?: string;
  readonly code: string;
  readonly elapsedMs?: number;
  readonly limitMs?: number;
  readonly state?: string;
}

const clamp = (value: string, limit: number): string =>
  value.length > limit ? `${value.slice(0, limit - 1)}~` : value;

const isSafeNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Render a detail as the suffix appended to the uniform failure message. */
export const describeOrganizationHandoffAuthorityFailure = (
  detail: OrganizationHandoffAuthorityFailureDetail
): string => {
  const fields: string[] = [];
  if (detail.budget !== undefined) fields.push(`budget=${detail.budget}`);
  if (detail.attempts !== undefined) fields.push(`attempts=${detail.attempts}`);
  if (detail.elapsedMs !== undefined) fields.push(`elapsed=${Math.round(detail.elapsedMs)}ms`);
  if (detail.limitMs !== undefined) fields.push(`limit=${Math.round(detail.limitMs)}ms`);
  if (detail.state !== undefined) fields.push(`state=${detail.state}`);
  return fields.length === 0 ? detail.code : `${detail.code} (${fields.join(" ")})`;
};

/** An authority failure that carries its structural diagnostics. */
export class OrganizationHandoffAuthorityFailure extends Error {
  public readonly detail: OrganizationHandoffAuthorityFailureDetail;
  public constructor(detail: OrganizationHandoffAuthorityFailureDetail) {
    super(`${ORGANIZATION_HANDOFF_AUTHORITY_ERROR}: ${describeOrganizationHandoffAuthorityFailure(detail)}`);
    this.name = "OrganizationHandoffAuthorityFailure";
    this.detail = detail;
  }
}

/**
 * Build an error for the uniform message plus optional detail. Callers that
 * have no diagnostics still produce the exact historical message, so existing
 * substring expectations and the store's opaque public boundary hold.
 */
export const createOrganizationHandoffAuthorityError = (
  detail?: OrganizationHandoffAuthorityFailureDetail
): Error => detail === undefined
  ? new Error(ORGANIZATION_HANDOFF_AUTHORITY_ERROR)
  : new OrganizationHandoffAuthorityFailure(detail);

/** Narrow an unknown IPC payload to a bounded, well-formed detail. */
export const parseOrganizationHandoffAuthorityFailureDetail = (
  raw: unknown
): OrganizationHandoffAuthorityFailureDetail | undefined => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.code !== "string" || value.code.length === 0) return undefined;
  return {
    ...(isSafeNumber(value.attempts) ? { attempts: value.attempts } : {}),
    ...(typeof value.budget === "string" ? { budget: clamp(value.budget, MAX_CODE_LENGTH) } : {}),
    code: clamp(value.code, MAX_CODE_LENGTH),
    ...(isSafeNumber(value.elapsedMs) ? { elapsedMs: value.elapsedMs } : {}),
    ...(isSafeNumber(value.limitMs) ? { limitMs: value.limitMs } : {}),
    ...(typeof value.state === "string" ? { state: clamp(value.state, MAX_STATE_LENGTH) } : {})
  };
};

/** Reduce an unknown thrown value to a bounded detail suitable for IPC. */
export const toOrganizationHandoffAuthorityFailureDetail = (
  error: unknown
): OrganizationHandoffAuthorityFailureDetail =>
  error instanceof OrganizationHandoffAuthorityFailure
    ? error.detail
    : { code: "unexpected_error", state: clamp(
        error instanceof Error ? `${error.name}` : typeof error, MAX_STATE_LENGTH) };

export interface OrganizationHandoffAuthorityBudgetOptions {
  readonly limitMs?: number;
  readonly maxAttempts?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * One request's convergence budget: a wall-clock deadline, a secondary attempt
 * cap, and adaptive backoff with jitter.
 *
 * The jitter matters as much as the deadline. Symmetric publishers waking on a
 * fixed 2ms timer retry in lockstep, so every peer re-observes the same
 * unfinished state and burns the budget in phase. Randomised, growing waits
 * break that convoy so peers observe each other's progress instead.
 */
export class OrganizationHandoffAuthorityBudget {
  #attempts = 0;
  readonly #limitMs: number;
  readonly #maxAttempts: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #startedAt: number;

  public constructor(options: OrganizationHandoffAuthorityBudgetOptions = {}) {
    this.#limitMs = options.limitMs ?? PUBLICATION_BUDGET_MS;
    this.#maxAttempts = options.maxAttempts ?? PUBLICATION_MAX_ATTEMPTS;
    this.#now = options.now ?? (() => performance.now());
    this.#sleep = options.sleep ?? (async (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
    this.#startedAt = this.#now();
  }

  public get attempts(): number { return this.#attempts; }
  public get elapsedMs(): number { return this.#now() - this.#startedAt; }
  public get limitMs(): number { return this.#limitMs; }

  /** True once no further waiting is permitted for this request. */
  public exhausted(): boolean {
    return this.elapsedMs >= this.#limitMs || this.#attempts >= this.#maxAttempts;
  }

  /**
   * True while a peer still deserves the benefit of the doubt. Once false, a
   * proven incomplete staging prefix may be retired — the caller has already
   * linked, or is about to link, the immutable final record that prevents that
   * prefix from winning a later election.
   */
  public patient(): boolean {
    return !this.exhausted() && this.elapsedMs < this.#limitMs * PUBLICATION_PATIENCE_FRACTION;
  }

  /** Snapshot the budget for a failure detail. */
  public snapshot(
    code: string, budget: string, state?: string
  ): OrganizationHandoffAuthorityFailureDetail {
    return {
      attempts: this.#attempts, budget, code,
      elapsedMs: this.elapsedMs, limitMs: this.#limitMs,
      ...(state === undefined ? {} : { state: clamp(state, MAX_STATE_LENGTH) })
    };
  }

  /** Back off before the next observation, never past the deadline. */
  public async wait(): Promise<void> {
    this.#attempts += 1;
    const growth = Math.min(MAX_WAIT_MS, BASE_WAIT_MS * 2 ** Math.min(this.#attempts - 1, 10));
    const remaining = Math.max(0, this.#limitMs - this.elapsedMs);
    const delay = Math.max(0, Math.min(remaining, growth * (0.5 + Math.random() * 0.5)));
    await this.#sleep(delay);
  }
}
