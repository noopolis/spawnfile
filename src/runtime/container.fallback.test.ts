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
        runtimeRef: "v2026.6.8",
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
        runtimeRef: "v2026.6.8",
        selectionSource: "runtime_registry_install",
        version: "2026.6.8"
      }
    });
    const recipe = await createRuntimeInstallRecipe("openclaw");

    expect(recipe.runtimeRoot).toBe("/usr/local/lib/node_modules/openclaw");
    expect(recipe.copyCommands).toEqual([]);
    expect(recipe.commands).toEqual([
      "npm install -g --omit=dev --no-fund --no-audit openclaw@2026.6.8"
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
        runtimeRef: "v2026.6.8",
        selectionSource: "runtime_registry_install",
        tag: "2026.6.8"
      }
    });
    const recipe = await createRuntimeInstallRecipe("openclaw");

    expect(recipe.runtimeRoot).toBe(`${RUNTIME_INSTALL_ROOT}/openclaw`);
    expect(recipe.commands).toEqual([]);
    expect(recipe.copyCommands).toEqual([
      "COPY --from=registry.example/spawnfile/openclaw-source:2026.6.8 /app /opt/spawnfile/runtime-installs/openclaw"
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
        runtimeRef: "v0.2.9",
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
        runtimeRef: "v0.2.9",
        selectionSource: "runtime_registry_install",
        tag: "v0.2.9",
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
      "https://github.com/sipeed/picoclaw/releases/download/v0.2.9/$asset"
    );
  });
});
