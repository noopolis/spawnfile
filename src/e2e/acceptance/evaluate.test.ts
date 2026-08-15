import { describe, expect, it } from "vitest";

import { evaluateAcceptanceProfile } from "./evaluate.js";
import { FULL_PROFILE, SLICE_PROFILE } from "./profiles.js";
import type { AcceptanceCheckResult } from "./profiles.js";

const allPassingResults = (
  profile: typeof SLICE_PROFILE | typeof FULL_PROFILE
): AcceptanceCheckResult[] =>
  profile.checks.map((check) => ({ checkId: check.id, status: "passed" as const }));

describe("evaluateAcceptanceProfile", () => {
  it("1. a required skip blocks acceptance (R2, the headline rule)", () => {
    const results = allPassingResults(SLICE_PROFILE).map((result) =>
      result.checkId === "slice-hidden-fact"
        ? { ...result, status: "skipped" as const, reason: "fixture unavailable" }
        : result
    );

    const verdict = evaluateAcceptanceProfile(SLICE_PROFILE, results);

    expect(verdict.verdict).toBe("not_accepted");
    expect(verdict.blockers).toContain(
      "required check skipped: slice-hidden-fact; required-skip = not_accepted (fixture unavailable)"
    );
  });

  it("2. optional subsystem-remote-host skipped with a reason, everything else passes -> accepted", () => {
    const results = allPassingResults(FULL_PROFILE).map((result) =>
      result.checkId === "subsystem-remote-host"
        ? { ...result, status: "skipped" as const, reason: "remote host box offline for maintenance" }
        : result
    );

    const verdict = evaluateAcceptanceProfile(FULL_PROFILE, results);

    expect(verdict.verdict).toBe("accepted");
    expect(verdict.blockers).toHaveLength(0);
    const remoteHost = verdict.checks.find((check) => check.id === "subsystem-remote-host");
    expect(remoteHost?.status).toBe("skipped");
    expect(remoteHost?.blocking).toBe(false);
  });

  it("3. a required failure blocks acceptance (R1)", () => {
    const results = allPassingResults(SLICE_PROFILE).map((result) =>
      result.checkId === "slice-causal-chain"
        ? { ...result, status: "failed" as const, reason: "chain broke at turn 4" }
        : result
    );

    const verdict = evaluateAcceptanceProfile(SLICE_PROFILE, results);

    expect(verdict.verdict).toBe("not_accepted");
    expect(verdict.blockers).toContain(
      "required check failed: slice-causal-chain (chain broke at turn 4)"
    );
  });

  it("4. a required check with no reported result blocks acceptance (R3)", () => {
    const results = allPassingResults(SLICE_PROFILE).filter(
      (result) => result.checkId !== "slice-memory-ablation"
    );

    const verdict = evaluateAcceptanceProfile(SLICE_PROFILE, results);

    expect(verdict.verdict).toBe("not_accepted");
    expect(verdict.blockers).toContain(
      "required check missing: slice-memory-ablation; no result reported"
    );
    const missing = verdict.checks.find((check) => check.id === "slice-memory-ablation");
    expect(missing?.status).toBe("missing");
  });

  it("5. an optional skip without a reason blocks acceptance (R4)", () => {
    const results = allPassingResults(FULL_PROFILE).map((result) =>
      result.checkId === "subsystem-remote-host"
        ? { ...result, status: "skipped" as const }
        : result
    );

    const verdict = evaluateAcceptanceProfile(FULL_PROFILE, results);

    expect(verdict.verdict).toBe("not_accepted");
    expect(verdict.blockers).toContain(
      "optional check skipped without reason: subsystem-remote-host"
    );
  });

  it("6. an optional failure blocks acceptance (R5 — optionality licenses absence, not failure)", () => {
    const results = allPassingResults(FULL_PROFILE).map((result) =>
      result.checkId === "subsystem-remote-host"
        ? { ...result, status: "failed" as const, reason: "connection refused" }
        : result
    );

    const verdict = evaluateAcceptanceProfile(FULL_PROFILE, results);

    expect(verdict.verdict).toBe("not_accepted");
    expect(verdict.blockers).toContain(
      "optional check failed: subsystem-remote-host; optionality licenses absence, not failure"
    );
  });

  it("7. an undeclared check id and a duplicate result both block acceptance (R6, R7)", () => {
    const results: AcceptanceCheckResult[] = [
      ...allPassingResults(SLICE_PROFILE),
      { checkId: "slice-hidden-fact", status: "passed" }, // duplicate of an already-passing id
      { checkId: "not-a-declared-check", status: "passed" } // undeclared
    ];

    const verdict = evaluateAcceptanceProfile(SLICE_PROFILE, results);

    expect(verdict.verdict).toBe("not_accepted");
    expect(verdict.blockers).toContain("undeclared check result: not-a-declared-check");
    expect(verdict.blockers).toContain("duplicate results for check: slice-hidden-fact");
    const duplicated = verdict.checks.find((check) => check.id === "slice-hidden-fact");
    expect(duplicated?.blocking).toBe(true);
  });

  it("8. all checks passing yields accepted with a correct summary", () => {
    const verdict = evaluateAcceptanceProfile(SLICE_PROFILE, allPassingResults(SLICE_PROFILE));

    expect(verdict.verdict).toBe("accepted");
    expect(verdict.blockers).toHaveLength(0);
    expect(verdict.summary).toEqual({
      passed: 10,
      skipped: 0,
      failed: 0,
      missing: 0,
      blocking: 0
    });
    expect(verdict.checks).toHaveLength(10);
  });

  it("9. contract: slice has 10 required checks, full has 28 with remote-host as the sole optional", () => {
    const sliceVerdict = evaluateAcceptanceProfile(SLICE_PROFILE, allPassingResults(SLICE_PROFILE));
    expect(sliceVerdict.checks).toHaveLength(10);
    expect(sliceVerdict.checks.every((check) => check.requirement === "required")).toBe(true);

    const fullResults = allPassingResults(FULL_PROFILE).map((result) =>
      result.checkId === "subsystem-remote-host"
        ? { ...result, status: "skipped" as const, reason: "offline" }
        : result
    );
    const fullVerdict = evaluateAcceptanceProfile(FULL_PROFILE, fullResults);
    expect(fullVerdict.checks).toHaveLength(28);
    const optionalChecks = fullVerdict.checks.filter((check) => check.requirement === "optional");
    expect(optionalChecks).toHaveLength(1);
    expect(optionalChecks[0]?.id).toBe("subsystem-remote-host");

    const ids = new Set(fullVerdict.checks.map((check) => check.id));
    expect(ids.size).toBe(fullVerdict.checks.length);
  });

  it("A2: a missing optional check is treated as an unexplained skip and blocks", () => {
    const results = allPassingResults(FULL_PROFILE).filter(
      (result) => result.checkId !== "subsystem-remote-host"
    );

    const verdict = evaluateAcceptanceProfile(FULL_PROFILE, results);

    expect(verdict.verdict).toBe("not_accepted");
    expect(verdict.blockers).toContain(
      "optional check missing: subsystem-remote-host; silence is not a reason"
    );
    const remoteHost = verdict.checks.find((check) => check.id === "subsystem-remote-host");
    expect(remoteHost?.status).toBe("missing");
    expect(remoteHost?.blocking).toBe(true);
  });

  it("10. is deterministic: an injected evaluatedAt produces an identical verdict across calls", () => {
    const evaluatedAt = "2026-01-01T00:00:00.000Z";
    const results = allPassingResults(FULL_PROFILE).map((result) =>
      result.checkId === "subsystem-remote-host"
        ? { ...result, status: "skipped" as const, reason: "offline" }
        : result
    );

    const first = evaluateAcceptanceProfile(FULL_PROFILE, results, { evaluatedAt });
    const second = evaluateAcceptanceProfile(FULL_PROFILE, results, { evaluatedAt });

    expect(first).toEqual(second);
    expect(first.evaluatedAt).toBe(evaluatedAt);
    expect(first.version).toBe("spawnfile.acceptance-verdict.v1");
  });
});
