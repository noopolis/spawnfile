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
      capabilityReceipt: undefined,
      capabilityReceipts: { amd64: "sha256:6558ccd7a9d4aa0dfc49dd5bd664002c11eea4b1e9d6bbf061a6d9b74a9b123d", arm64: "sha256:0c66a9d3e1bc65ac2b8b8fdb7e3c327ed026ac8e7b8c2365fdd7aabe2f74f727" },
      contractManifestSha256: "sha256:85de96d75cf1e02e0e88bd6e1dcce39a125c1d5b97f1eb9c01911a0d5c3316e8",
      digest: "sha256:40badb0eca3b332aa23ac8eef45f9f07e739dc51aed825ee4ca496542a3e0697",
      ecosystem: "node",
      image: "noopolis/spawnfile-runtime-daimon",
      installHint: "Copy a pinned Daimon runtime image.",
      kind: "container_image",
      runtimeName: "daimon",
      runtimeRef: "d8aec28df0f0b5705db537136662642416a70d71",
      selectionSource: "runtime_registry_install",
      tag: "0.2.12-d8aec28"
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

  it("resolves Pi install selection from the pinned npm package", async () => {
    await expect(resolveRuntimeInstallSelection("pi")).resolves.toEqual({
      ecosystem: "node",
      installHint: "Install pinned Pi SDK dependencies inside the generated runtime app.",
      kind: "npm",
      packageName: "@earendil-works/pi-coding-agent",
      runtimeName: "pi",
      runtimeRef: "v0.79.10",
      selectionSource: "runtime_registry_install",
      version: "0.79.10"
    });
  });

  it("rejects exploratory runtimes for install selection", async () => {
    await expect(resolveRuntimeInstallSelection("openfang")).rejects.toThrow(/exploratory/);
  });
});
