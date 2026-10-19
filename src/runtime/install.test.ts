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
      capabilityReceipts: { amd64: "sha256:26fe7ff328bb45fb6643b0792ab38b2658d5fcc3d2d8bd67d9848ea2987c04cc", arm64: "sha256:347da7c613ad3430e018de829587a6d686c498c6168ef4be6b8dd501fdb07ebb" },
      contractManifestSha256: "sha256:e39551277c6727c8807b1247e759f57addcee3f17f1405ebc927179647d64de6",
      digest: "sha256:2de3bd522ce88202b3295efa4f19c72c350e5e18c25ccba55e5acf3395e8569c",
      ecosystem: "node",
      image: "noopolis/spawnfile-runtime-daimon",
      installHint: "Copy a pinned Daimon runtime image.",
      kind: "container_image",
      runtimeName: "daimon",
      runtimeRef: "14d0298c00861f949bb6993d1af9751cde53319f",
      selectionSource: "runtime_registry_install",
      tag: "0.2.1-14d0298"
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
