import { afterEach, describe, expect, it, vi } from "vitest";

const loadContainerModule = async (selectionByRuntime: Record<string, unknown>) => {
  vi.doMock("./install.js", () => ({
    resolveRuntimeInstallSelection: vi.fn(async (runtimeName: string) => {
      const selection = selectionByRuntime[runtimeName];
      if (!selection) {
        throw new Error(`Unexpected runtime install lookup: ${runtimeName}`);
      }

      return selection;
    })
  }));

  return import("./container.js");
};

describe("runtime container install recipe fallbacks", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("./install.js");
  });

  it("rejects OpenClaw source installs for generated containers", async () => {
    const { createRuntimeInstallRecipe } = await loadContainerModule({
      openclaw: {
        ecosystem: "node",
        installHint: "Checkout the pinned repo ref and install from the repository root.",
        kind: "source_repo",
        remote: "https://github.com/openclaw/openclaw.git",
        runtimeName: "openclaw",
        runtimeRef: "v2026.6.11",
        selectionSource: "runtime_registry_ref"
      }
    });

    await expect(createRuntimeInstallRecipe("openclaw")).rejects.toThrow(
      /must use a compiled artifact install/
    );
  });

  it("creates an OpenClaw npm install recipe when the runtime opts into npm", async () => {
    const { createRuntimeInstallRecipe } = await loadContainerModule({
      openclaw: {
        ecosystem: "node",
        installHint: "Install the pinned OpenClaw package version from npm.",
        kind: "npm",
        packageName: "openclaw",
        runtimeName: "openclaw",
        runtimeRef: "v2026.6.11",
        selectionSource: "runtime_registry_install",
        version: "2026.6.11"
      }
    });
    const recipe = await createRuntimeInstallRecipe("openclaw");

    expect(recipe.runtimeRoot).toBe("/usr/local/lib/node_modules/openclaw");
    expect(recipe.copyCommands).toEqual([]);
    expect(recipe.commands).toEqual([
      "npm install -g --omit=dev --no-fund --no-audit openclaw@2026.6.11"
    ]);
  });

  it("creates an OpenClaw image-copy recipe when the runtime opts into a source image", async () => {
    const { createRuntimeInstallRecipe, RUNTIME_INSTALL_ROOT } = await loadContainerModule({
      openclaw: {
        ecosystem: "node",
        image: "registry.example/spawnfile/openclaw-source",
        installHint: "Copy the pinned OpenClaw runtime files from the official container image.",
        kind: "container_image",
        runtimeName: "openclaw",
        runtimeRef: "v2026.6.11",
        selectionSource: "runtime_registry_install",
        tag: "2026.6.11"
      }
    });
    const recipe = await createRuntimeInstallRecipe("openclaw");

    expect(recipe.runtimeRoot).toBe(`${RUNTIME_INSTALL_ROOT}/openclaw`);
    expect(recipe.commands).toEqual([]);
    expect(recipe.copyCommands).toEqual([
      "COPY --from=registry.example/spawnfile/openclaw-source:2026.6.11 /opt/spawnfile/runtime-installs/openclaw /opt/spawnfile/runtime-installs/openclaw"
    ]);
  });

  it("rejects PicoClaw source installs for generated containers", async () => {
    const { createRuntimeInstallRecipe } = await loadContainerModule({
      picoclaw: {
        ecosystem: "go",
        installHint: "Checkout the pinned repo ref and build/install from the repository root.",
        kind: "source_repo",
        remote: "https://github.com/sipeed/picoclaw.git",
        runtimeName: "picoclaw",
        runtimeRef: "v0.3.1",
        selectionSource: "runtime_registry_ref"
      }
    });

    await expect(createRuntimeInstallRecipe("picoclaw")).rejects.toThrow(
      /must use a compiled artifact install/
    );
  });

  it("creates a PicoClaw release-archive install recipe when the runtime opts into it", async () => {
    const { createRuntimeInstallRecipe, RUNTIME_INSTALL_ROOT } = await loadContainerModule({
      picoclaw: {
        binaryName: "picoclaw",
        ecosystem: "go",
        installHint: "Download the pinned PicoClaw release archive for the target platform.",
        kind: "github_release_archive",
        repository: "sipeed/picoclaw",
        runtimeName: "picoclaw",
        runtimeRef: "v0.3.1",
        selectionSource: "runtime_registry_install",
        tag: "v0.3.1",
        versionedAssets: {
          linux_amd64: "picoclaw_Linux_x86_64.tar.gz",
          linux_arm64: "picoclaw_Linux_arm64.tar.gz"
        }
      }
    });
    const recipe = await createRuntimeInstallRecipe("picoclaw");

    expect(recipe.runtimeRoot).toBe(`${RUNTIME_INSTALL_ROOT}/picoclaw`);
    expect(recipe.copyCommands).toEqual([]);
    expect(recipe.commands).toContain(`mkdir -p ${RUNTIME_INSTALL_ROOT}/picoclaw/bin`);
    expect(recipe.commands[1]).toContain(
      "https://github.com/sipeed/picoclaw/releases/download/v0.3.1/$asset"
    );
  });

  it("rejects Daimon source installs for generated containers", async () => {
    const { createRuntimeInstallRecipe } = await loadContainerModule({
      daimon: {
        ecosystem: "node",
        installHint: "Checkout the pinned repo ref and install from the repository root.",
        kind: "source_repo",
        remote: "https://github.com/noopolis/daimon.git",
        runtimeName: "daimon",
        runtimeRef: "v0.1.2",
        selectionSource: "runtime_registry_ref"
      }
    });

    await expect(createRuntimeInstallRecipe("daimon")).rejects.toThrow(
      /must use a compiled artifact install/
    );
  });

  it("rejects a Daimon npm install because public hosts require a generic image", async () => {
    const { createRuntimeInstallRecipe, RUNTIME_INSTALL_ROOT } = await loadContainerModule({
      daimon: {
        ecosystem: "node",
        installHint: "Install the pinned Daimon package version from npm.",
        kind: "npm",
        packageName: "@noopolis/daimon",
        runtimeName: "daimon",
        runtimeRef: "v0.1.2",
        selectionSource: "runtime_registry_install",
        version: "0.1.2"
      }
    });
    await expect(createRuntimeInstallRecipe("daimon")).rejects.toThrow(
      "requires a pinned generic Daimon runtime image"
    );
  });

  it("rejects OpenClaw when no compiled artifact is available", async () => {
    const { createRuntimeInstallRecipe } = await loadContainerModule({
      openclaw: {
        ecosystem: "node",
        installHint: "Use a compiled OpenClaw runtime artifact.",
        kind: "github_release_archive",
        runtimeName: "openclaw",
        runtimeRef: "v2026.6.11",
        selectionSource: "runtime_registry_install",
        repository: "noopolis/openclaw",
        tag: "2026.6.11",
        assets: {
          linux_amd64: "openclaw.tgz",
          linux_arm64: "openclaw.tgz"
        },
        binaryName: "openclaw"
      }
    });

    await expect(createRuntimeInstallRecipe("openclaw")).rejects.toThrow(
      /has no compiled artifact recipe for github_release_archive/
    );
  });

  it("rejects non-image Daimon artifact installs", async () => {
    const { createRuntimeInstallRecipe } = await loadContainerModule({
      daimon: {
        binaryName: "daimon",
        ecosystem: "node",
        installHint: "Download a Daimon release archive.",
        kind: "github_release_archive",
        repository: "noopolis/daimon",
        runtimeName: "daimon",
        runtimeRef: "v0.1.2",
        selectionSource: "runtime_registry_install",
        tag: "v0.1.2",
        versionedAssets: {
          linux_amd64: "daimon-linux-amd64.tar.gz",
          linux_arm64: "daimon-linux-arm64.tar.gz"
        }
      }
    });

    await expect(createRuntimeInstallRecipe("daimon")).rejects.toThrow(
      "requires a pinned generic Daimon runtime image"
    );
  });

  it("rejects Pi source installs for generated containers", async () => {
    const { createRuntimeInstallRecipe } = await loadContainerModule({
      pi: {
        ecosystem: "node",
        installHint: "Checkout the pinned repo ref and install from the repository root.",
        kind: "source_repo",
        remote: "https://github.com/earendil-works/pi.git",
        runtimeName: "pi",
        runtimeRef: "v0.79.10",
        selectionSource: "runtime_registry_ref"
      }
    });

    await expect(createRuntimeInstallRecipe("pi")).rejects.toThrow(
      /must use a compiled artifact install/
    );
  });

  it("rejects non-npm Pi artifact installs", async () => {
    const { createRuntimeInstallRecipe } = await loadContainerModule({
      pi: {
        binaryName: "pi",
        ecosystem: "node",
        installHint: "Download a Pi release archive.",
        kind: "github_release_archive",
        repository: "earendil-works/pi",
        runtimeName: "pi",
        runtimeRef: "v0.79.10",
        selectionSource: "runtime_registry_install",
        tag: "v0.79.10",
        versionedAssets: {
          linux_amd64: "pi-linux-amd64.tar.gz",
          linux_arm64: "pi-linux-arm64.tar.gz"
        }
      }
    });

    await expect(createRuntimeInstallRecipe("pi")).rejects.toThrow(
      /has no compiled artifact recipe for github_release_archive/
    );
  });

  it("rejects Pi container-image installs for generated containers", async () => {
    const { createRuntimeInstallRecipe } = await loadContainerModule({
      pi: {
        ecosystem: "node",
        image: "registry.example/spawnfile/pi-source",
        installHint: "Copy a pinned Pi runtime image.",
        kind: "container_image",
        remote: "https://github.com/earendil-works/pi.git",
        runtimeName: "pi",
        runtimeRef: "v0.79.10",
        selectionSource: "runtime_registry_install",
        tag: "0.79.10"
      }
    });

    await expect(createRuntimeInstallRecipe("pi")).rejects.toThrow(
      /has no compiled artifact recipe for container_image/
    );
  });
});
