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
      capabilityReceipts: { amd64: "sha256:87648523888cf96773cdee733d819def3aaa43fa2626e0f945b841fc2313edd0", arm64: "sha256:e714abca4ba1bb9e2ea13fcb0620aba7a3b3b3a6d002c09bf9857a720a5fc34d" },
      contractManifestSha256: "sha256:85de96d75cf1e02e0e88bd6e1dcce39a125c1d5b97f1eb9c01911a0d5c3316e8",
      digest: "sha256:3e9743eaeb8ebae529e8e2768320695e97dc73bb5d639ffa6e2a479d3db81dbd",
      ecosystem: "node",
      image: "noopolis/spawnfile-runtime-daimon",
      installHint: "Copy a pinned Daimon runtime image.",
      kind: "container_image",
      runtimeName: "daimon",
      runtimeRef: "0f2e73b4794f9ad03173b05a99486a5459715d4c",
      selectionSource: "runtime_registry_install",
      tag: "0.2.10-0f2e73b"
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
