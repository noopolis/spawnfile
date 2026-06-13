import { describe, expect, it } from "vitest";

import {
  hasRegistryComponent,
  parseImageReference,
  parseImplicitImageReference
} from "./imageRef.js";

describe("parseImageReference", () => {
  it("parses tagged, digested, and registry-qualified refs", () => {
    expect(parseImageReference("research-cell:1.0.0")).toEqual({
      digest: null,
      name: "research-cell",
      registry: null,
      tag: "1.0.0"
    });
    expect(parseImageReference("you/research-cell@sha256:" + "a".repeat(64))).toEqual({
      digest: `sha256:${"a".repeat(64)}`,
      name: "you/research-cell",
      registry: null,
      tag: null
    });
    expect(parseImageReference("localhost:5000/research-cell:1.0.0")).toEqual({
      digest: null,
      name: "research-cell",
      registry: "localhost:5000",
      tag: "1.0.0"
    });
    expect(parseImageReference("ghcr.io/you/research-cell")).toEqual({
      digest: null,
      name: "you/research-cell",
      registry: "ghcr.io",
      tag: null
    });
  });

  it("accepts bare repository names at the grammar level", () => {
    expect(parseImageReference("research-cell")).toEqual({
      digest: null,
      name: "research-cell",
      registry: null,
      tag: null
    });
  });

  it("rejects malformed refs", () => {
    expect(parseImageReference("")).toBeNull();
    expect(parseImageReference("has spaces:1.0")).toBeNull();
    expect(parseImageReference("UPPER/case:1.0")).toBeNull();
    expect(parseImageReference("name@sha256:short")).toBeNull();
    expect(parseImageReference("name:bad tag")).toBeNull();
  });
});

describe("parseImplicitImageReference", () => {
  it("requires a tag, digest, or registry component", () => {
    expect(parseImplicitImageReference("research-cell")).toBeNull();
    expect(parseImplicitImageReference("you/research-cell")).toBeNull();
    expect(parseImplicitImageReference("research-cell:1.0.0")).not.toBeNull();
    expect(
      parseImplicitImageReference("you/research-cell@sha256:" + "b".repeat(64))
    ).not.toBeNull();
    expect(parseImplicitImageReference("localhost:5000/research-cell")).not.toBeNull();
  });
});

describe("hasRegistryComponent", () => {
  it("detects registry-qualified refs", () => {
    expect(hasRegistryComponent("ghcr.io/you/org:1.0")).toBe(true);
    expect(hasRegistryComponent("localhost:5000/org")).toBe(true);
    expect(hasRegistryComponent("you/org:1.0")).toBe(false);
  });
});
