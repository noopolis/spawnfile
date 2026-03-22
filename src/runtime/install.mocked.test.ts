import { afterEach, describe, expect, it, vi } from "vitest";

import { SpawnfileError } from "../shared/index.js";
import type { RuntimeRegistryEntry } from "./registry.js";

const loadInstallModule = async (
  registryEntries: RuntimeRegistryEntry[]
) => {
  vi.doMock("./registry.js", () => ({
    assertRuntimeCanCompile: vi.fn(async (runtimeName: string) => {
      const runtime = registryEntries.find((entry) => entry.name === runtimeName);
      if (!runtime) {
        throw new SpawnfileError("runtime_error", `Unknown runtime binding: ${runtimeName}`);
      }

      if (runtime.status === "exploratory") {
        throw new SpawnfileError(
          "runtime_error",
          `Runtime ${runtimeName} is exploratory and cannot be compiled in v0.1`
        );
      }

      return runtime;
    }),
    loadRuntimeRegistry: vi.fn(async () => registryEntries)
  }));

  return import("./install.js");
};

describe("runtime install selection with mocked registry data", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("./registry.js");
  });

  it("falls back to source-repo selection when a runtime opts into source installs", async () => {
    const registryEntries: RuntimeRegistryEntry[] = [
      {
        defaultBranch: "main",
        install: { kind: "source_repo" },
        name: "openclaw",
        ref: "v2026.3.13-1",
        remote: "git@github.com:openclaw/openclaw.git",
        status: "active"
      }
    ];
    const { resolveRuntimeInstallSelection } = await loadInstallModule(registryEntries);

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

  it("falls back to source-repo selection when no explicit install strategy is set", async () => {
    const registryEntries: RuntimeRegistryEntry[] = [
      {
        defaultBranch: "main",
        name: "openclaw",
        ref: "v2026.3.13-1",
        remote: "git+https://github.com/openclaw/openclaw.git",
        status: "active"
      }
    ];
    const { resolveRuntimeInstallSelection } = await loadInstallModule(registryEntries);

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

  it("resolves a pinned container image install when the runtime opts into it", async () => {
    const registryEntries: RuntimeRegistryEntry[] = [
      {
        defaultBranch: "main",
        install: {
          image: "ghcr.io/openclaw/openclaw",
          kind: "container_image",
          tag: "2026.3.13-1"
        },
        name: "openclaw",
        ref: "v2026.3.13-1",
        remote: "git@github.com:openclaw/openclaw.git",
        status: "active"
      }
    ];
    const { resolveRuntimeInstallSelection } = await loadInstallModule(registryEntries);

    await expect(resolveRuntimeInstallSelection("openclaw")).resolves.toEqual({
      ecosystem: "node",
      image: "ghcr.io/openclaw/openclaw",
      installHint: "Copy the pinned OpenClaw runtime files from the official container image.",
      kind: "container_image",
      runtimeName: "openclaw",
      runtimeRef: "v2026.3.13-1",
      selectionSource: "runtime_registry_install",
      tag: "2026.3.13-1"
    });
  });

  it("resolves a pinned npm install when the runtime opts into it", async () => {
    const registryEntries: RuntimeRegistryEntry[] = [
      {
        defaultBranch: "main",
        install: {
          kind: "npm",
          package: "openclaw",
          version: "2026.3.13"
        },
        name: "openclaw",
        ref: "v2026.3.13-1",
        remote: "git@github.com:openclaw/openclaw.git",
        status: "active"
      }
    ];
    const { resolveRuntimeInstallSelection } = await loadInstallModule(registryEntries);

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

  it("resolves a pinned release archive install when the runtime opts into it", async () => {
    const registryEntries: RuntimeRegistryEntry[] = [
      {
        defaultBranch: "main",
        install: {
          assets: {
            linux_amd64: "picoclaw_Linux_x86_64.tar.gz",
            linux_arm64: "picoclaw_Linux_arm64.tar.gz"
          },
          binary: "picoclaw",
          kind: "github_release_archive",
          repository: "sipeed/picoclaw",
          tag: "v0.2.3"
        },
        name: "picoclaw",
        ref: "v0.2.3",
        remote: "git@github.com:sipeed/picoclaw.git",
        status: "active"
      }
    ];
    const { resolveRuntimeInstallSelection } = await loadInstallModule(registryEntries);

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

  it("resolves a pinned release bundle install when the runtime opts into it", async () => {
    const registryEntries: RuntimeRegistryEntry[] = [
      {
        defaultBranch: "main",
        install: {
          asset: "tinyagi-bundle.tar.gz",
          kind: "github_release_bundle",
          repository: "TinyAGI/tinyagi",
          tag: "v0.0.15"
        },
        name: "tinyclaw",
        ref: "v0.0.15",
        remote: "git@github.com:TinyAGI/tinyclaw.git",
        status: "active"
      }
    ];
    const { resolveRuntimeInstallSelection } = await loadInstallModule(registryEntries);

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

  it("fails when a compileable runtime has no install profile", async () => {
    const registryEntries: RuntimeRegistryEntry[] = [
      {
        defaultBranch: "main",
        name: "customclaw",
        ref: "v1.0.0",
        remote: "git@github.com:noop/customclaw.git",
        status: "active"
      }
    ];
    const { resolveRuntimeInstallSelection } = await loadInstallModule(registryEntries);

    await expect(resolveRuntimeInstallSelection("customclaw")).rejects.toThrow(
      /no install selection profile/
    );
  });

  it("fails coverage when compileable runtimes exceed install profiles", async () => {
    const registryEntries: RuntimeRegistryEntry[] = [
      {
        defaultBranch: "main",
        name: "customclaw",
        ref: "v1.0.0",
        remote: "git@github.com:noop/customclaw.git",
        status: "active"
      },
      {
        defaultBranch: "main",
        name: "openclaw",
        ref: "v2026.3.13-1",
        remote: "git@github.com:openclaw/openclaw.git",
        status: "active"
      }
    ];
    const { assertInstallSelectionsCoverCompileableRuntimes } = await loadInstallModule(
      registryEntries
    );

    await expect(assertInstallSelectionsCoverCompileableRuntimes()).rejects.toThrow(
      /do not cover all compileable runtimes/
    );
  });
});
