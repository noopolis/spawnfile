import { describe, expect, it } from "vitest";

import { normalizeProjectLabelSlug } from "./projectName.js";

describe("normalizeProjectLabelSlug", () => {
  it("keeps already-valid identifiers unchanged", () => {
    expect(normalizeProjectLabelSlug("research-cell")).toBe("research-cell");
    expect(normalizeProjectLabelSlug("Org_1.beta")).toBe("Org_1.beta");
  });

  it("replaces invalid characters and strips invalid edges", () => {
    expect(normalizeProjectLabelSlug("Research Cell #2")).toBe("Research-Cell-2");
    expect(normalizeProjectLabelSlug("--weird name--")).toBe("weird-name");
  });

  it("rejects names that cannot become a label-safe slug", () => {
    expect(() => normalizeProjectLabelSlug("###")).toThrow(/label-safe slug/);
    expect(() => normalizeProjectLabelSlug("")).toThrow(/label-safe slug/);
  });
});
