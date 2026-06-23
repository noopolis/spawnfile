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
      "daimon",
      "openclaw",
      "pi",
      "picoclaw"
    ]);
  });

  it("resolves Daimon install selection from the pinned runtime image", async () => {
    await expect(resolveRuntimeInstallSelection("daimon")).resolves.toEqual({
      ecosystem: "node",
      image: "noopolis/spawnfile-runtime-daimon",
      installHint: "Copy a pinned Daimon runtime image.",
      kind: "container_image",
      runtimeName: "daimon",
      runtimeRef: "v0.1.0",
      selectionSource: "runtime_registry_install",
      tag: "0.1.0"
    });
  });

  it("resolves OpenClaw install selection from the pinned npm package", async () => {
    await expect(resolveRuntimeInstallSelection("openclaw")).resolves.toEqual({
      ecosystem: "node",
      installHint: "Install the pinned OpenClaw package version from npm.",
      kind: "npm",
      packageName: "openclaw",
      runtimeName: "openclaw",
      runtimeRef: "v2026.6.8",
      selectionSource: "runtime_registry_install",
      version: "2026.6.8"
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
      runtimeRef: "v0.2.9",
      selectionSource: "runtime_registry_install",
      tag: "v0.2.9",
      versionedAssets: {
        linux_amd64: "picoclaw_Linux_x86_64.tar.gz",
        linux_arm64: "picoclaw_Linux_arm64.tar.gz"
      }
    });
  });

  it("resolves Pi install selection from the pinned npm package", async () => {
    await expect(resolveRuntimeInstallSelection("pi")).resolves.toEqual({
      ecosystem: "node",
      installHint: "Install pinned Pi SDK dependencies inside the generated runtime app.",
      kind: "npm",
      packageName: "@earendil-works/pi-coding-agent",
      runtimeName: "pi",
      runtimeRef: "v0.79.9",
      selectionSource: "runtime_registry_install",
      version: "0.79.9"
    });
  });

  it("rejects exploratory runtimes for install selection", async () => {
    await expect(resolveRuntimeInstallSelection("nullclaw")).rejects.toThrow(/exploratory/);
  });
});
