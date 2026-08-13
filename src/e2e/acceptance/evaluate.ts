// B60 — Pure acceptance-profile evaluation.
//
// evaluateAcceptanceProfile() is the sole entry point. It takes a predeclared
// profile (see profiles.ts) and a list of externally-produced check results,
// and returns a deterministic verdict. It performs no IO and calls no other
// subsystem: everything it needs is passed in as arguments.
//
// Blocking rules (see AGENTS.md for the D1-D3 rationale):
//   R1 required failed             -> block
//   R2 required skipped            -> block (a required skip never becomes an accept)
//   R3 required missing            -> block
//   R4 optional skipped, no reason -> block
//   R5 optional failed             -> block (optionality licenses absence, not failure)
//   R6 undeclared check result     -> block
//   R7 duplicate results for an id -> block
//   A1 optional skipped, w/ reason -> non-blocking (recorded)
//   A2 optional missing            -> treated as R4 (silence is not a reason)

import type {
  AcceptanceCheckDeclaration,
  AcceptanceCheckResult,
  AcceptanceProfile,
  AcceptanceProfileId,
  AcceptanceCheckStatus,
  CheckRequirement
} from "./profiles.js";

export type EvaluatedCheckStatus = AcceptanceCheckStatus | "missing";

export interface EvaluatedCheck {
  id: string;
  requirement: CheckRequirement;
  status: EvaluatedCheckStatus;
  reason: string;
  blocking: boolean;
}

export interface AcceptanceVerdictSummary {
  passed: number;
  skipped: number;
  failed: number;
  missing: number;
  blocking: number;
}

export interface AcceptanceVerdict {
  version: "spawnfile.acceptance-verdict.v1";
  profileId: AcceptanceProfileId;
  verdict: "accepted" | "not_accepted";
  blockers: string[];
  checks: EvaluatedCheck[];
  summary: AcceptanceVerdictSummary;
  evaluatedAt: string;
}

export interface EvaluateAcceptanceProfileOptions {
  evaluatedAt?: string;
}

export const ACCEPTANCE_VERDICT_VERSION = "spawnfile.acceptance-verdict.v1" as const;

const formatReason = (reason?: string): string =>
  reason && reason.trim().length > 0 ? reason : "no reason provided";

const groupResultsByCheckId = (
  results: AcceptanceCheckResult[]
): Map<string, AcceptanceCheckResult[]> => {
  const grouped = new Map<string, AcceptanceCheckResult[]>();
  for (const result of results) {
    const bucket = grouped.get(result.checkId);
    if (bucket) {
      bucket.push(result);
    } else {
      grouped.set(result.checkId, [result]);
    }
  }
  return grouped;
};

const evaluateMissing = (
  declaration: AcceptanceCheckDeclaration,
  blockers: string[]
): EvaluatedCheck => {
  if (declaration.requirement === "required") {
    // R3
    blockers.push(`required check missing: ${declaration.id}; no result reported`);
    return {
      id: declaration.id,
      requirement: declaration.requirement,
      status: "missing",
      reason: "no result reported",
      blocking: true
    };
  }
  // A2 (treated as R4): silence is not a reason.
  blockers.push(`optional check missing: ${declaration.id}; silence is not a reason`);
  return {
    id: declaration.id,
    requirement: declaration.requirement,
    status: "missing",
    reason: "silence is not a reason",
    blocking: true
  };
};

const evaluatePassed = (declaration: AcceptanceCheckDeclaration, primary: AcceptanceCheckResult): EvaluatedCheck => ({
  id: declaration.id,
  requirement: declaration.requirement,
  status: "passed",
  reason: primary.reason ?? "",
  blocking: false
});

const evaluateSkipped = (
  declaration: AcceptanceCheckDeclaration,
  primary: AcceptanceCheckResult,
  blockers: string[]
): EvaluatedCheck => {
  if (declaration.requirement === "required") {
    // R2 — the headline rule: a required skip never converts to an accept.
    const reason = formatReason(primary.reason);
    blockers.push(
      `required check skipped: ${declaration.id}; required-skip = not_accepted (${reason})`
    );
    return {
      id: declaration.id,
      requirement: declaration.requirement,
      status: "skipped",
      reason,
      blocking: true
    };
  }

  const hasReason = primary.reason !== undefined && primary.reason.trim().length > 0;
  if (hasReason) {
    // A1 — optional skip with a nonempty reason is recorded, non-blocking.
    return {
      id: declaration.id,
      requirement: declaration.requirement,
      status: "skipped",
      reason: primary.reason as string,
      blocking: false
    };
  }

  // R4 — optional skip with an empty/absent reason blocks.
  blockers.push(`optional check skipped without reason: ${declaration.id}`);
  return {
    id: declaration.id,
    requirement: declaration.requirement,
    status: "skipped",
    reason: "no reason provided",
    blocking: true
  };
};

const evaluateFailed = (
  declaration: AcceptanceCheckDeclaration,
  primary: AcceptanceCheckResult,
  blockers: string[]
): EvaluatedCheck => {
  const reason = formatReason(primary.reason);
  if (declaration.requirement === "required") {
    // R1
    blockers.push(`required check failed: ${declaration.id} (${reason})`);
  } else {
    // R5 — optionality licenses absence, not failure.
    blockers.push(
      `optional check failed: ${declaration.id}; optionality licenses absence, not failure`
    );
  }
  return {
    id: declaration.id,
    requirement: declaration.requirement,
    status: "failed",
    reason,
    blocking: true
  };
};

const evaluateDeclaredCheck = (
  declaration: AcceptanceCheckDeclaration,
  primary: AcceptanceCheckResult | undefined,
  blockers: string[]
): EvaluatedCheck => {
  if (!primary) {
    return evaluateMissing(declaration, blockers);
  }
  if (primary.status === "passed") {
    return evaluatePassed(declaration, primary);
  }
  if (primary.status === "skipped") {
    return evaluateSkipped(declaration, primary, blockers);
  }
  return evaluateFailed(declaration, primary, blockers);
};

export const evaluateAcceptanceProfile = (
  profile: AcceptanceProfile,
  results: AcceptanceCheckResult[],
  options: EvaluateAcceptanceProfileOptions = {}
): AcceptanceVerdict => {
  const declaredIds = new Set(profile.checks.map((declaration) => declaration.id));
  const resultsByCheckId = groupResultsByCheckId(results);

  const blockers: string[] = [];

  // R6 — a result for a checkId the profile never declared.
  for (const checkId of resultsByCheckId.keys()) {
    if (!declaredIds.has(checkId)) {
      blockers.push(`undeclared check result: ${checkId}`);
    }
  }

  const checks: EvaluatedCheck[] = [];
  const summary: AcceptanceVerdictSummary = {
    passed: 0,
    skipped: 0,
    failed: 0,
    missing: 0,
    blocking: 0
  };

  for (const declaration of profile.checks) {
    const bucket = resultsByCheckId.get(declaration.id) ?? [];
    const isDuplicate = bucket.length > 1;
    if (isDuplicate) {
      // R7 — duplicate results for the same declared check.
      blockers.push(`duplicate results for check: ${declaration.id}`);
    }

    const evaluated = evaluateDeclaredCheck(declaration, bucket[0], blockers);
    const finalEvaluated: EvaluatedCheck = isDuplicate
      ? { ...evaluated, blocking: true }
      : evaluated;

    checks.push(finalEvaluated);
    summary[finalEvaluated.status] += 1;
  }

  summary.blocking = blockers.length;

  return {
    version: ACCEPTANCE_VERDICT_VERSION,
    profileId: profile.id,
    verdict: blockers.length === 0 ? "accepted" : "not_accepted",
    blockers,
    checks,
    summary,
    evaluatedAt: options.evaluatedAt ?? new Date().toISOString()
  };
};
