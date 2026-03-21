import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertPortableRelativePath,
  getManifestPath,
  resolveProjectPath,
  toPosixPath
} from "./paths.js";

describe("paths", () => {
  it("rejects absolute paths", () => {
    expect(() => assertPortableRelativePath("/tmp/oops")).toThrowError(/Absolute paths/);
  });

  it("rejects parent directory traversal", () => {
    expect(() => assertPortableRelativePath("../oops")).toThrowError(/Path traversal/);
  });

  it("rejects backslashes in portable relative paths", () => {
    expect(() => assertPortableRelativePath("docs\\NOTES.md")).toThrowError(
      /forward slashes/
    );
  });

  it("keeps explicit Spawnfile paths intact", () => {
    expect(getManifestPath("/tmp/demo/Spawnfile")).toBe(path.resolve("/tmp/demo/Spawnfile"));
  });

  it("builds manifest paths from directories", () => {
    expect(getManifestPath("/tmp/demo")).toBe(path.resolve("/tmp/demo", "Spawnfile"));
  });

  it("resolves project-local relative paths", () => {
    expect(resolveProjectPath("/tmp/demo/Spawnfile", "skills/web")).toBe(
      path.resolve("/tmp/demo/skills/web")
    );
  });

  it("normalizes separators to posix form", () => {
    expect(toPosixPath(path.join("a", "b"))).toBe("a/b");
  });
});
