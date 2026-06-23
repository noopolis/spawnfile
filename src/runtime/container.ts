import { SpawnfileError } from "../shared/index.js";

import { resolveRuntimeInstallSelection } from "./install.js";

export const RUNTIME_INSTALL_ROOT = "/opt/spawnfile/runtime-installs";
const PI_RUNTIME_BASE_IMAGE_ENV = "SPAWNFILE_PI_RUNTIME_BASE_IMAGE";
const DAIMON_RUNTIME_IMAGE_ENV = "SPAWNFILE_DAIMON_RUNTIME_IMAGE";
const DAIMON_RUNTIME_BASE_IMAGE_ENV = "SPAWNFILE_DAIMON_RUNTIME_BASE_IMAGE";
const PI_AI_PACKAGE_NAME = "@earendil-works/pi-ai";
const PI_CODING_AGENT_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PI_PACKAGE_VERSION = "0.79.9";

export interface RuntimeInstallRecipe {
  baseImage?: string;
  commands: string[];
  copyCommands: string[];
  runtimeName: string;
  runtimeRoot: string;
}

const assertArtifactInstallSelection = (
  runtimeName: string,
  selection: Awaited<ReturnType<typeof resolveRuntimeInstallSelection>>
): void => {
  if (selection.kind !== "source_repo") {
    return;
  }

  throw new SpawnfileError(
    "runtime_error",
    `Runtime ${runtimeName} must use a compiled artifact install for generated containers`
  );
};

const createPicoClawArchiveInstallCommands = (
  runtimeRoot: string,
  selection: Extract<
    Awaited<ReturnType<typeof resolveRuntimeInstallSelection>>,
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

const createRuntimeImageCopyCommand = (
  imageRef: string,
  runtimeRoot: string
): string => `COPY --from=${imageRef} ${runtimeRoot} ${runtimeRoot}`;

export const createRuntimeInstallRecipe = async (
  runtimeName: string
): Promise<RuntimeInstallRecipe> => {
  const selection = await resolveRuntimeInstallSelection(runtimeName);
  assertArtifactInstallSelection(runtimeName, selection);

  const installRoot = `${RUNTIME_INSTALL_ROOT}/${runtimeName}`;

  switch (runtimeName) {
    case "openclaw": {
      if (selection.kind !== "container_image" && selection.kind !== "npm") {
        throw new SpawnfileError(
          "runtime_error",
          `Runtime ${runtimeName} has no compiled artifact recipe for ${selection.kind}`
        );
      }

      return {
        commands:
          selection.kind === "container_image"
            ? []
            : [`npm install -g --omit=dev --no-fund --no-audit ${selection.packageName}@${selection.version}`],
        copyCommands:
          selection.kind === "container_image"
            ? [`COPY --from=${selection.image}:${selection.tag} /app ${installRoot}`]
            : [],
        runtimeName,
        runtimeRoot:
          selection.kind === "container_image"
            ? installRoot
            : `/usr/local/lib/node_modules/${selection.packageName}`
      };
    }
    case "picoclaw": {
      if (selection.kind !== "github_release_archive") {
        throw new SpawnfileError(
          "runtime_error",
          `Runtime ${runtimeName} has no compiled artifact recipe for ${selection.kind}`
        );
      }

      return {
        commands: createPicoClawArchiveInstallCommands(installRoot, selection),
        copyCommands: [],
        runtimeName,
        runtimeRoot: installRoot
      };
    }
    case "daimon": {
      const daimonRuntimeImage =
        process.env[DAIMON_RUNTIME_IMAGE_ENV]?.trim() ||
        process.env[DAIMON_RUNTIME_BASE_IMAGE_ENV]?.trim() ||
        (selection.kind === "container_image"
          ? `${selection.image}:${selection.tag}`
          : undefined);

      if (daimonRuntimeImage) {
        return {
          commands: [],
          copyCommands: [createRuntimeImageCopyCommand(daimonRuntimeImage, installRoot)],
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

      const npmPackages = [
        `${selection.packageName}@${selection.version}`,
        `${PI_CODING_AGENT_PACKAGE_NAME}@${PI_PACKAGE_VERSION}`,
        `${PI_AI_PACKAGE_NAME}@${PI_PACKAGE_VERSION}`
      ];

      return {
        commands: [
          `mkdir -p ${installRoot}`,
          `cd ${installRoot} && npm install --omit=dev --no-fund --no-audit ${npmPackages.join(" ")}`
        ],
        copyCommands: [],
        runtimeName,
        runtimeRoot: installRoot
      };
    }
    case "pi": {
      if (selection.kind !== "npm") {
        throw new SpawnfileError(
          "runtime_error",
          `Runtime ${runtimeName} has no compiled artifact recipe for ${selection.kind}`
        );
      }

      const prebuiltBaseImage = process.env[PI_RUNTIME_BASE_IMAGE_ENV]?.trim() || undefined;
      const npmPackages = [
        `${selection.packageName}@${selection.version}`,
        `${PI_AI_PACKAGE_NAME}@${selection.version}`
      ];

      return {
        ...(prebuiltBaseImage ? { baseImage: prebuiltBaseImage } : {}),
        commands: prebuiltBaseImage
          ? [`mkdir -p ${installRoot}`]
          : [
              `mkdir -p ${installRoot}`,
              `cd ${installRoot} && npm install --omit=dev --no-fund --no-audit ${npmPackages.join(" ")}`
            ],
        copyCommands: [],
        runtimeName,
        runtimeRoot: installRoot
      };
    }
    /* c8 ignore next 5 -- compileable runtimes are exhaustively covered above */
    default:
      throw new SpawnfileError(
        "runtime_error",
        `Runtime ${runtimeName} has no container install recipe`
      );
  }
};
