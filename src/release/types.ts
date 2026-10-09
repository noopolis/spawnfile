/**
 * The fixed vocabulary a release failure is reported in. A notifier receives
 * exactly one of these words, so whoever reads the notification learns a small
 * closed set rather than free text; the detail travels separately.
 */
export const RELEASE_FAILURE_REASONS = Object.freeze([
  "blocked",
  "build-failed",
  "drain-failed",
  "deploy-failed",
  "health-failed",
  "resume-failed",
  "post-deploy-failed",
  "ledger-failed",
  "interrupted",
  "release-deferred"
] as const);

export type ReleaseFailureReason = (typeof RELEASE_FAILURE_REASONS)[number];

/** Carries the reason word with the error so the orchestrator never guesses it. */
export class ReleaseError extends Error {
  public readonly reason: ReleaseFailureReason;

  public constructor(reason: ReleaseFailureReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.reason = reason;
    this.name = "ReleaseError";
  }
}

export const isReleaseError = (value: unknown): value is ReleaseError =>
  value instanceof ReleaseError;

export interface ReleaseTimings {
  build_ms: number | null;
  compile_ms: number;
  deploy_ms: number | null;
  drain_ms: number | null;
  total_ms: number;
}

/**
 * `released`: a new image is running and recorded. `unchanged`: the recorded
 * identity is the one running, nothing was built or touched. `deferred`: the
 * running organization did not drain within the bound, the release was
 * abandoned before deploying and admission resumed. `failed`: see `reason`.
 */
export type ReleaseOutcome =
  | { identity: string; imageTag: string; kind: "unchanged" }
  | { identity: string; imageId: string; imageTag: string; kind: "released"; timings: ReleaseTimings }
  | { identity: string; kind: "deferred"; message: string; notified: boolean }
  | { identity: string | null; kind: "failed"; message: string; notified: boolean; reason: ReleaseFailureReason };

/** Exit codes: 0 released/unchanged, 75 (EX_TEMPFAIL) deferred, 1 failed. */
export const releaseExitCode = (outcome: ReleaseOutcome): number =>
  outcome.kind === "failed" ? 1 : outcome.kind === "deferred" ? 75 : 0;
