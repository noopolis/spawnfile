import { describe, expect, it } from "vitest";

import { normalizeDeploymentName } from "../../../deployment/names.js";
import { trialSlug } from "./boot.js";

describe("trialSlug", () => {
  it("never leaves a doubled hyphen where the cut lands after one", () => {
    // The Codex judge's trial id cut at 32 characters ended in "-", and the
    // deployment refused "judge-codex-codex-gpt-5-6-terra--147daf71".
    const slug = trialSlug("judge-codex-codex-gpt-5-6-terra-low-run-1");
    expect(slug).toMatch(/^judge-codex-codex-gpt-5-6-terra-[a-f0-9]{8}$/u);
    expect(normalizeDeploymentName(slug)).toBe(slug);
  });

  it("keeps distinct ids distinct and falls back for an id with no slug", () => {
    expect(trialSlug("a".repeat(40) + "1")).not.toBe(trialSlug("a".repeat(40) + "2"));
    expect(trialSlug("!!!")).toMatch(/^trial-[a-f0-9]{8}$/u);
  });
});
