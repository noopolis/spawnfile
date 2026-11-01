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
      "picoclaw"
    ]);
  });

  it("resolves Daimon install selection from the pinned runtime image", async () => {
    await expect(resolveRuntimeInstallSelection("daimon")).resolves.toEqual({
      capabilityReceipt: undefined,
      capabilityReceipts: { amd64: "sha256:8c51027bc374c560229cf73671ba6e68da40870e45ecfb7b09046d02ea4c8abf", arm64: "sha256:e250b202dbb467c2ff9b98bb44f4fd3e9a21b42d7818aa07d3fddb7934410de5" },
      contractManifestSha256: "sha256:85de96d75cf1e02e0e88bd6e1dcce39a125c1d5b97f1eb9c01911a0d5c3316e8",
      digest: "sha256:eed57f422ebb94f3bc19385d9a2a60d099bd8e955d4d95886a37cc6a5ae07cd6",
      ecosystem: "node",
      image: "noopolis/spawnfile-runtime-daimon",
      installHint: "Copy a pinned Daimon runtime image.",
      kind: "container_image",
      runtimeName: "daimon",
      runtimeRef: "5505a4ffb242e6920990814d28fcf275b8ee8fff",
      selectionSource: "runtime_registry_install",
      tag: "0.2.14-5505a4f"
    });
  });

  it("resolves OpenClaw install selection from the pinned runtime image", async () => {
    await expect(resolveRuntimeInstallSelection("openclaw")).resolves.toEqual({
      ecosystem: "node",
      image: "noopolis/spawnfile-runtime-openclaw",
      installHint: "Copy the pinned OpenClaw runtime files from the official container image.",
      kind: "container_image",
      runtimeName: "openclaw",
      runtimeRef: "v2026.6.11",
      selectionSource: "runtime_registry_install",
      tag: "2026.6.11"
    });
  });

  it("resolves PicoClaw install selection from the pinned runtime image", async () => {
    await expect(resolveRuntimeInstallSelection("picoclaw")).resolves.toEqual({
      ecosystem: "go",
      image: "noopolis/spawnfile-runtime-picoclaw",
      installHint: "Copy the pinned PicoClaw runtime files from the official container image.",
      kind: "container_image",
      runtimeName: "picoclaw",
      runtimeRef: "v0.3.1",
      selectionSource: "runtime_registry_install",
      tag: "0.3.1"
    });
  });

  it("rejects exploratory runtimes for install selection", async () => {
    await expect(resolveRuntimeInstallSelection("openfang")).rejects.toThrow(/exploratory/);
  });
});
