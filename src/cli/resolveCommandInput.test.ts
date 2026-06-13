import { describe, expect, it } from "vitest";

import { resolveCommandInput } from "./resolveCommandInput.js";

describe("resolveCommandInput", () => {
  it("treats existing directories as project paths", () => {
    expect(resolveCommandInput("fixtures/single-agent")).toEqual({
      kind: "project",
      path: "fixtures/single-agent"
    });
  });

  it("treats existing files as project paths", () => {
    expect(resolveCommandInput("fixtures/single-agent/Spawnfile")).toEqual({
      kind: "project",
      path: "fixtures/single-agent/Spawnfile"
    });
  });

  it("treats tagged refs as image references", () => {
    expect(resolveCommandInput("you/research-cell:1.0.0")).toEqual({
      kind: "image",
      ref: "you/research-cell:1.0.0"
    });
  });

  it("treats digest and registry refs as image references", () => {
    expect(resolveCommandInput("ghcr.io/you/org")).toEqual({
      kind: "image",
      ref: "ghcr.io/you/org"
    });
    expect(
      resolveCommandInput("you/org@sha256:" + "a".repeat(64))
    ).toEqual({ kind: "image", ref: "you/org@sha256:" + "a".repeat(64) });
  });

  it("rejects bare names in implicit mode", () => {
    expect(resolveCommandInput("research-cell")).toEqual({
      kind: "invalid",
      value: "research-cell"
    });
  });

  it("forces image mode (including bare names) with --image", () => {
    expect(resolveCommandInput("research-cell", { forceImage: true })).toEqual({
      kind: "image",
      ref: "research-cell"
    });
  });

  it("prefers a directory over a same-spelled ref unless forced", () => {
    expect(resolveCommandInput("fixtures/single-agent")).toMatchObject({ kind: "project" });
    expect(resolveCommandInput("fixtures/single-agent", { forceImage: true })).toMatchObject({
      kind: "image"
    });
  });
});
