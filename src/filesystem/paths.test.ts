import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  assertPortableRelativePath,
  getManifestPath,
  resolveProjectOutputDirectory,
  resolveProjectPath,
  toPosixPath
} from "./paths.js";

describe("paths", () => {
  it("rejects absolute paths", () => {
    expect(() => assertPortableRelativePath("/tmp/oops")).toThrowError(/Absolute paths/);
  });

  it("allows parent-relative portable paths", () => {
    expect(() => assertPortableRelativePath("../skills/web")).not.toThrow();
  });

  it("rejects backslashes in portable relative paths", () => {
    expect(() => assertPortableRelativePath("docs\\NOTES.md")).toThrowError(
      /forward slashes/
    );
  });

  it("keeps explicit Spawnfile paths intact", () => {
    expect(getManifestPath("/tmp/demo/Spawnfile")).toBe(path.resolve("/tmp/demo/Spawnfile"));
  });

  it("keeps any existing manifest file path intact", () => {
    const project = mkdtempSync(path.join(tmpdir(), "spawnfile-paths-"));
    const manifest = path.join(project, "Spawnfile.v22");
    writeFileSync(manifest, "version: 0.1\n");
    try {
      expect(getManifestPath(manifest)).toBe(path.resolve(manifest));
      expect(resolveProjectOutputDirectory(manifest, undefined, ".spawn")).toBe(
        path.join(project, ".spawn")
      );
    } finally {
      rmSync(project, { force: true, recursive: true });
    }
  });

  it("builds manifest paths from directories", () => {
    expect(getManifestPath("/tmp/demo")).toBe(path.resolve("/tmp/demo", "Spawnfile"));
  });

  it("resolves project-local relative paths", () => {
    expect(resolveProjectPath("/tmp/demo/Spawnfile", "skills/web")).toBe(
      path.resolve("/tmp/demo/skills/web")
    );
  });

  it("resolves parent-relative paths from the manifest directory", () => {
    expect(resolveProjectPath("/tmp/demo/agentic-org/Spawnfile", "../.claude/skills/web")).toBe(
      path.resolve("/tmp/demo/.claude/skills/web")
    );
  });

  it("normalizes separators to posix form", () => {
    expect(toPosixPath(path.join("a", "b"))).toBe("a/b");
  });

  describe("resolveProjectOutputDirectory", () => {
    it("defaults to .spawn under the resolved project directory", () => {
      expect(resolveProjectOutputDirectory("/abs/org", undefined, ".spawn")).toBe(
        path.join("/abs/org", ".spawn")
      );
    });

    it("resolves the project root from a Spawnfile path argument", () => {
      expect(resolveProjectOutputDirectory("/abs/org/Spawnfile", undefined, ".spawn")).toBe(
        path.join("/abs/org", ".spawn")
      );
    });

    it("honors an explicit --out resolved against cwd", () => {
      expect(resolveProjectOutputDirectory("/abs/org", "build/out", ".spawn")).toBe(
        path.resolve("build/out")
      );
    });
  });
});
