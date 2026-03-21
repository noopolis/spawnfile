import { describe, expect, it } from "vitest";

import {
  assertInstallSelectionsCoverCompileableRuntimes,
  listInstallSelectionRuntimes,
  resolveRuntimeInstallSelection
} from "./install.js";

describe("runtime install selection", () => {
  it("covers all compileable runtimes from runtimes.yaml", async () => {
    await expect(assertInstallSelectionsCoverCompileableRuntimes()).resolves.toBeUndefined();
    expect(listInstallSelectionRuntimes()).toEqual(["openclaw", "picoclaw", "tinyclaw"]);
  });

  it("resolves OpenClaw install selection from the pinned runtime ref", async () => {
    await expect(resolveRuntimeInstallSelection("openclaw")).resolves.toEqual({
      ecosystem: "node",
      installHint: "Checkout the pinned repo ref and install from the repository root.",
      kind: "source_repo",
      remote: "https://github.com/openclaw/openclaw.git",
      runtimeName: "openclaw",
      runtimeRef: "v2026.3.13-1",
      selectionSource: "runtime_registry_ref"
    });
  });

  it("resolves PicoClaw install selection from the pinned runtime ref", async () => {
    await expect(resolveRuntimeInstallSelection("picoclaw")).resolves.toEqual({
      ecosystem: "go",
      installHint: "Checkout the pinned repo ref and build/install from the repository root.",
      kind: "source_repo",
      remote: "https://github.com/sipeed/picoclaw.git",
      runtimeName: "picoclaw",
      runtimeRef: "v0.2.3",
      selectionSource: "runtime_registry_ref"
    });
  });

  it("resolves TinyClaw install selection from the pinned runtime ref", async () => {
    await expect(resolveRuntimeInstallSelection("tinyclaw")).resolves.toEqual({
      ecosystem: "node",
      installHint: "Checkout the pinned repo ref and run the TinyAGI install flow from the repository root.",
      kind: "source_repo",
      remote: "https://github.com/TinyAGI/tinyclaw.git",
      runtimeName: "tinyclaw",
      runtimeRef: "v0.0.15",
      selectionSource: "runtime_registry_ref"
    });
  });

  it("rejects exploratory runtimes for install selection", async () => {
    await expect(resolveRuntimeInstallSelection("nullclaw")).rejects.toThrow(/exploratory/);
  });
});
