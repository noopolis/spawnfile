import { describe, expect, it } from "vitest";

import {
  ACCEPTANCE_PROFILES,
  FULL_PROFILE,
  getAcceptanceProfile,
  SLICE_PROFILE
} from "./profiles.js";
import type { AcceptanceCheckDeclaration } from "./profiles.js";

const uniqueIds = (checks: AcceptanceCheckDeclaration[]): Set<string> =>
  new Set(checks.map((check) => check.id));

describe("SLICE_PROFILE", () => {
  it("declares exactly 10 checks, all required, zero optional", () => {
    expect(SLICE_PROFILE.checks).toHaveLength(10);
    expect(SLICE_PROFILE.checks.every((check) => check.requirement === "required")).toBe(true);
    expect(SLICE_PROFILE.checks.some((check) => check.requirement === "optional")).toBe(false);
  });

  it("has unique ids and a nonempty burnlistRefs list for every check", () => {
    expect(uniqueIds(SLICE_PROFILE.checks).size).toBe(SLICE_PROFILE.checks.length);
    for (const check of SLICE_PROFILE.checks) {
      expect(check.burnlistRefs.length).toBeGreaterThan(0);
      expect(check.title.length).toBeGreaterThan(0);
    }
  });
});

describe("FULL_PROFILE", () => {
  it("declares exactly 28 checks with subsystem-remote-4090 as the sole optional check", () => {
    expect(FULL_PROFILE.checks).toHaveLength(28);

    const optionalChecks = FULL_PROFILE.checks.filter((check) => check.requirement === "optional");
    expect(optionalChecks).toHaveLength(1);
    expect(optionalChecks[0]?.id).toBe("subsystem-remote-4090");

    const requiredChecks = FULL_PROFILE.checks.filter((check) => check.requirement === "required");
    expect(requiredChecks).toHaveLength(27);
  });

  it("has unique ids and a nonempty burnlistRefs list for every check", () => {
    expect(uniqueIds(FULL_PROFILE.checks).size).toBe(FULL_PROFILE.checks.length);
    for (const check of FULL_PROFILE.checks) {
      expect(check.burnlistRefs.length).toBeGreaterThan(0);
      expect(check.title.length).toBeGreaterThan(0);
    }
  });

  it("carries every slice check as required, without redeclaring B67 outside subsystem-conformance", () => {
    const sliceIds = uniqueIds(SLICE_PROFILE.checks);
    for (const id of sliceIds) {
      expect(uniqueIds(FULL_PROFILE.checks).has(id)).toBe(true);
    }

    const conformanceDeclarations = FULL_PROFILE.checks.filter((check) =>
      check.burnlistRefs.includes("B67")
    );
    expect(conformanceDeclarations).toHaveLength(1);
    expect(conformanceDeclarations[0]?.id).toBe("subsystem-conformance");
  });
});

describe("ACCEPTANCE_PROFILES / getAcceptanceProfile", () => {
  it("registers both profiles by id", () => {
    expect(ACCEPTANCE_PROFILES.slice).toBe(SLICE_PROFILE);
    expect(ACCEPTANCE_PROFILES.full).toBe(FULL_PROFILE);
  });

  it("looks up a profile by id", () => {
    expect(getAcceptanceProfile("slice")).toBe(SLICE_PROFILE);
    expect(getAcceptanceProfile("full")).toBe(FULL_PROFILE);
  });
});
