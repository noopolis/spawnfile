import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createWorkspaceResourceShellFunctions } from "./containerWorkspaceResourceRender.js";

/**
 * Runs the rendered `prepare_bundle_resource` in real bash. The two helpers it calls afterwards only
 * set ownership and links, which need root, so they are stubbed: what is under test is the decision
 * to materialize the archive or to demand an identity, and that decision happens before them.
 */
const prepareBundle = (root: string, backingPath: string, identity: string): { status: number; output: string } => {
  const archive = path.join(root, "bundle.tar");
  const payload = path.join(root, "payload");
  mkdirSync(payload, { recursive: true });
  writeFileSync(path.join(payload, "content.txt"), "from the archive\n");
  execFileSync("tar", ["-cf", archive, "-C", payload, "."]);
  const script = [
    "set -euo pipefail",
    ...createWorkspaceResourceShellFunctions(),
    "mark_readonly_resource() { :; }",
    "prepare_resource_link() { :; }",
    `prepare_bundle_resource 'etopo' '${path.join(root, "link")}' '${backingPath}' '${archive}' '${identity}'`
  ].join("\n");
  try {
    return { output: execFileSync("bash", ["-c", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), status: 0 };
  } catch (error) {
    const failure = error as { status?: number; stderr?: Buffer | string };
    return { output: String(failure.stderr ?? ""), status: failure.status ?? 1 };
  }
};

describe("bundle-backed workspace resources", () => {
  const identity = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

  it("materializes into a backing directory another startup step pre-created empty", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "spawnfile-bundle-"));
    try {
      const backing = path.join(root, "instances", "agent", "etopo-relief");
      // Exactly what the Daimon entrypoint leaves behind so the Grok broker's deny placement has a target.
      mkdirSync(backing, { recursive: true });
      const result = prepareBundle(root, backing, identity);
      expect(result.status, result.output).toBe(0);
      expect(readFileSync(path.join(backing, "content.txt"), "utf8")).toBe("from the archive\n");
      expect(readFileSync(path.join(backing, ".spawnfile-bundle-identity"), "utf8")).toBe(identity);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("still refuses a populated backing that does not attest the pinned identity", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "spawnfile-bundle-"));
    try {
      const backing = path.join(root, "instances", "agent", "etopo-relief");
      mkdirSync(backing, { recursive: true });
      writeFileSync(path.join(backing, "stale.txt"), "left by something else\n");
      const result = prepareBundle(root, backing, identity);
      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/identity mismatch/u);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("refuses a populated backing whose sentinel attests a different archive", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "spawnfile-bundle-"));
    try {
      const backing = path.join(root, "instances", "agent", "etopo-relief");
      mkdirSync(backing, { recursive: true });
      writeFileSync(path.join(backing, ".spawnfile-bundle-identity"), "sha256:1111111111111111111111111111111111111111111111111111111111111111");
      const result = prepareBundle(root, backing, identity);
      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/identity mismatch/u);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
