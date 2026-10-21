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
      capabilityReceipts: { amd64: "sha256:5c40362da20ca0d1a3bf3090c30b73472c9c06a8cbfe71217cac40d1422dc530", arm64: "sha256:d857cb2518222fb8ceeca79e6da8fecb992bce189be7fc981ea4b4061795f284" },
      contractManifestSha256: "sha256:e39551277c6727c8807b1247e759f57addcee3f17f1405ebc927179647d64de6",
      digest: "sha256:c9b3095fc5043d60b0d0f955045bc66e8ec5bb76b4edad7fe5de5cef2c0461ec",
      ecosystem: "node",
      image: "noopolis/spawnfile-runtime-daimon",
      installHint: "Copy a pinned Daimon runtime image.",
      kind: "container_image",
      runtimeName: "daimon",
      runtimeRef: "1027460c4b165c2e9f8d6b7e3e72dc4ae763e7dd",
      selectionSource: "runtime_registry_install",
      tag: "0.2.4-1027460"
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
