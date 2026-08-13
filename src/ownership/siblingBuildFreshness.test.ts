import { describe, expect, it } from "vitest";
import { checkSiblingBuildFreshness } from "./siblingBuildFreshness.js";

const base = { packageName: "@noopolis/mneme", packageDirectory: "/workspace/ecosystem/mneme", hasSourceDirectory: true };

describe("sibling build freshness", () => {
  it("passes published packages without a freshness comparison", () => {
    expect(checkSiblingBuildFreshness({ ...base, hasSourceDirectory: false, sourceFiles: [], outputFiles: [] })).toEqual({ packageName: base.packageName, linked: false, sourcesScanned: 0, outputsScanned: 0, ok: true });
  });
  it("rejects linked packages with zero sources or zero outputs", () => {
    const noSources = checkSiblingBuildFreshness({ ...base, sourceFiles: [], outputFiles: [{ path: "index.js", mtimeMs: 1 }] });
    const noOutputs = checkSiblingBuildFreshness({ ...base, sourceFiles: [{ path: "index.ts", mtimeMs: 1 }], outputFiles: [] });
    expect(noSources).toMatchObject({ linked: true, sourcesScanned: 0, outputsScanned: 1, ok: false });
    expect(noSources.message).toMatch(/zero source/);
    expect(noOutputs).toMatchObject({ linked: true, sourcesScanned: 1, outputsScanned: 0, ok: false });
    expect(noOutputs.message).toMatch(/no emitted JavaScript/);
  });
  it("reports non-zero scan counts for a fresh linked package", () => {
    expect(checkSiblingBuildFreshness({ ...base, sourceFiles: [{ path: "index.ts", mtimeMs: 10 }], outputFiles: [{ path: "index.js", mtimeMs: 10 }] })).toMatchObject({ linked: true, sourcesScanned: 1, outputsScanned: 1, ok: true });
  });
  it("compares newest source to oldest output", () => expect(checkSiblingBuildFreshness({ ...base, sourceFiles: [{ path: "fresh.ts", mtimeMs: 20 }], outputFiles: [{ path: "fresh.js", mtimeMs: 30 }, { path: "old.js", mtimeMs: 10 }] }).message).toMatch(/fresh\.ts \(20\).*old\.js \(10\)/));
  it("ignores excluded source files", () => expect(checkSiblingBuildFreshness({ ...base, sourceFiles: [{ path: "index.ts", mtimeMs: 10 }, { path: "x.test.ts", mtimeMs: 100 }], outputFiles: [{ path: "index.js", mtimeMs: 10 }] }).ok).toBe(true));
});
