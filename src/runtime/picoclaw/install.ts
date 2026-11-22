import { SpawnfileError } from "../../shared/index.js";

import type { RuntimeInstallRecipe } from "../container.js";
import type { NativeInstallRecipeInput, NativeInstallHintProfile } from "../containerRecipe.js";
import { createRuntimeImageCopyCommand, resolveRuntimeImageRef } from "../containerRecipe.js";
import type { RuntimeInstallSelection } from "../install.js";

export const picoClawInstallHints = {
  container_image: {
    ecosystem: "go",
    installHint: "Copy the pinned PicoClaw runtime files from the official container image."
  },
  github_release_archive: {
    ecosystem: "go",
    installHint: "Download the pinned PicoClaw release archive for the target platform."
  },
  npm: {
    ecosystem: "node",
    installHint: "Install the pinned PicoClaw package version from npm."
  },
  source_repo: {
    ecosystem: "go",
    installHint: "Checkout the pinned repo ref and build/install from the repository root."
  }
} satisfies NativeInstallHintProfile;

const PICOCLAW_RUNTIME_IMAGE_ENV = "SPAWNFILE_PICOCLAW_RUNTIME_IMAGE";

const createPicoClawArchiveInstallCommands = (
  runtimeRoot: string,
  selection: Extract<
    RuntimeInstallSelection,
    { kind: "github_release_archive" }
  >
): string[] => [
  `mkdir -p ${runtimeRoot}/bin`,
  `arch="$(dpkg --print-architecture)" && case "$arch" in amd64) asset=${JSON.stringify(
    selection.versionedAssets.linux_amd64
  )} ;; arm64) asset=${JSON.stringify(
    selection.versionedAssets.linux_arm64
  )} ;; *) echo "Unsupported PicoClaw release architecture: $arch" >&2; exit 1 ;; esac && url="https://github.com/${selection.repository}/releases/download/${selection.tag}/$asset" && curl -fsSL -o /tmp/picoclaw.tar.gz "$url" && rm -rf /tmp/picoclaw-extract && mkdir -p /tmp/picoclaw-extract && tar -xzf /tmp/picoclaw.tar.gz -C /tmp/picoclaw-extract && binary_path="$(find /tmp/picoclaw-extract -type f -name ${JSON.stringify(
    selection.binaryName
  )} | head -n 1)" && [ -n "$binary_path" ] && install -m 0755 "$binary_path" ${runtimeRoot}/bin/${selection.binaryName} && ln -sf ${runtimeRoot}/bin/${selection.binaryName} /usr/local/bin/${selection.binaryName} && rm -rf /tmp/picoclaw.tar.gz /tmp/picoclaw-extract`
];

export const createPicoClawInstallRecipe = ({
  containerEnv,
  installRoot,
  runtimeName,
  selection
}: NativeInstallRecipeInput): RuntimeInstallRecipe => {
  const picoClawRuntimeImage = resolveRuntimeImageRef(PICOCLAW_RUNTIME_IMAGE_ENV, selection);
  if (picoClawRuntimeImage) {
    return {
      commands: [
        `mkdir -p /usr/local/bin && ln -sf ${installRoot}/bin/picoclaw /usr/local/bin/picoclaw`
      ],
      copyCommands: [createRuntimeImageCopyCommand(picoClawRuntimeImage, installRoot)],
      env: containerEnv,
      runtimeName,
      runtimeRoot: installRoot
    };
  }

  if (selection.kind !== "github_release_archive") {
    throw new SpawnfileError(
      "runtime_error",
      `Runtime ${runtimeName} has no compiled artifact recipe for ${selection.kind}`
    );
  }

  return {
    commands: createPicoClawArchiveInstallCommands(installRoot, selection),
    copyCommands: [],
    env: containerEnv,
    runtimeName,
    runtimeRoot: installRoot
  };
};
