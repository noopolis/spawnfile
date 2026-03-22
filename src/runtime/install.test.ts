import { describe, expect, it } from "vitest";

import {
  assertInstallSelectionsCoverCompileableRuntimes,
  listInstallSelectionRuntimes,
  resolveRuntimeInstallSelection
} from "./install.js";

describe("runtime install selection", () => {
  it("covers all compileable runtimes from runtimes.yaml", async () => {
    await expect(assertInstallSelectionsCoverCompileableRuntimes()).resolves.toBeUndefined();
    await expect(listInstallSelectionRuntimes()).resolves.toEqual([
      "openclaw",
      "picoclaw",
      "tinyclaw"
    ]);
  });

  it("resolves OpenClaw install selection from the pinned npm package", async () => {
    await expect(resolveRuntimeInstallSelection("openclaw")).resolves.toEqual({
      ecosystem: "node",
      installHint: "Install the pinned OpenClaw package version from npm.",
      kind: "npm",
      packageName: "openclaw",
      runtimeName: "openclaw",
      runtimeRef: "v2026.3.13-1",
      selectionSource: "runtime_registry_install",
      version: "2026.3.13"
    });
  });

  it("resolves PicoClaw install selection from the pinned release archive", async () => {
    await expect(resolveRuntimeInstallSelection("picoclaw")).resolves.toEqual({
      binaryName: "picoclaw",
      ecosystem: "go",
      installHint: "Download the pinned PicoClaw release archive for the target platform.",
      kind: "github_release_archive",
      repository: "sipeed/picoclaw",
      runtimeName: "picoclaw",
      runtimeRef: "v0.2.3",
      selectionSource: "runtime_registry_install",
      tag: "v0.2.3",
      versionedAssets: {
        linux_amd64: "picoclaw_Linux_x86_64.tar.gz",
        linux_arm64: "picoclaw_Linux_arm64.tar.gz"
      }
    });
  });

  it("resolves TinyClaw install selection from the pinned release bundle", async () => {
    await expect(resolveRuntimeInstallSelection("tinyclaw")).resolves.toEqual({
      asset: "tinyagi-bundle.tar.gz",
      ecosystem: "node",
      installHint: "Download the pinned TinyClaw bundle artifact from the release.",
      kind: "github_release_bundle",
      repository: "TinyAGI/tinyagi",
      runtimeName: "tinyclaw",
      runtimeRef: "v0.0.15",
      selectionSource: "runtime_registry_install",
      tag: "v0.0.15"
    });
  });

  it("rejects exploratory runtimes for install selection", async () => {
    await expect(resolveRuntimeInstallSelection("nullclaw")).rejects.toThrow(/exploratory/);
  });
});
