import { SpawnfileError } from "../../shared/index.js";

import type { RuntimeInstallRecipe } from "../container.js";
import type { NativeInstallRecipeInput, NativeInstallHintProfile } from "../containerRecipe.js";
import { createRuntimeImageCopyCommand, globalNpmInstallCommand, resolveRuntimeImageRef } from "../containerRecipe.js";

export const openClawInstallHints = {
  container_image: {
    ecosystem: "node",
    installHint:
      "Copy the pinned OpenClaw runtime files from the official container image."
  },
  github_release_archive: {
    ecosystem: "node",
    installHint: "Download the pinned OpenClaw artifact archive from the release."
  },
  npm: {
    ecosystem: "node",
    installHint: "Install the pinned OpenClaw package version from npm."
  },
  source_repo: {
    ecosystem: "node",
    installHint: "Checkout the pinned repo ref and install from the repository root."
  }
} satisfies NativeInstallHintProfile;

const OPENCLAW_RUNTIME_IMAGE_ENV = "SPAWNFILE_OPENCLAW_RUNTIME_IMAGE";

export const createOpenClawInstallRecipe = ({
  containerEnv,
  installRoot,
  runtimeName,
  selection
}: NativeInstallRecipeInput): RuntimeInstallRecipe => {
  const openClawRuntimeImage = resolveRuntimeImageRef(OPENCLAW_RUNTIME_IMAGE_ENV, selection);
  if (openClawRuntimeImage) {
    return {
      commands: [],
      copyCommands: [createRuntimeImageCopyCommand(openClawRuntimeImage, installRoot)],
      env: containerEnv,
      runtimeName,
      runtimeRoot: installRoot
    };
  }

  if (selection.kind !== "npm") {
    throw new SpawnfileError(
      "runtime_error",
      `Runtime ${runtimeName} has no compiled artifact recipe for ${selection.kind}`
    );
  }

  return {
    commands: [
      globalNpmInstallCommand([`${selection.packageName}@${selection.version}`])
    ],
    copyCommands: [],
    env: containerEnv,
    runtimeName,
    runtimeRoot: `/usr/local/lib/node_modules/${selection.packageName}`
  };
};
