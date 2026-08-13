import { SpawnfileError } from "../shared/index.js";

import { NOOPOLIS_RUN_ID_ENV, resolveNoopolisRunId } from "./common.js";
import {
  createVendorCopyCommand,
  needsVendorCopyCommand,
  resolveInstallPackageSpec,
  type RuntimeContainerPackageOverrides
} from "./containerPackageOverrides.js";
import { resolveRuntimeInstallSelection } from "./install.js";

export const RUNTIME_INSTALL_ROOT = "/opt/spawnfile/runtime-installs";
const PI_RUNTIME_BASE_IMAGE_ENV = "SPAWNFILE_PI_RUNTIME_BASE_IMAGE";
const DAIMON_RUNTIME_IMAGE_ENV = "SPAWNFILE_DAIMON_RUNTIME_IMAGE";
const DAIMON_RUNTIME_BASE_IMAGE_ENV = "SPAWNFILE_DAIMON_RUNTIME_BASE_IMAGE";
const OPENCLAW_RUNTIME_IMAGE_ENV = "SPAWNFILE_OPENCLAW_RUNTIME_IMAGE";
const PICOCLAW_RUNTIME_IMAGE_ENV = "SPAWNFILE_PICOCLAW_RUNTIME_IMAGE";
const DAIMON_PACKAGE_NAME = "@noopolis/daimon";
const DAIMON_PACKAGE_VERSION = "0.1.2";
const MNEME_PACKAGE_NAME = "@noopolis/mneme";
const MNEME_PACKAGE_VERSION = "0.1.1";
const PI_AI_PACKAGE_NAME = "@earendil-works/pi-ai";
const PI_CODING_AGENT_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PI_PACKAGE_VERSION = "0.79.10";

export interface RuntimeInstallRecipe {
  baseImage?: string;
  commands: string[];
  copyCommands: string[];
  /**
   * Container environment variables this recipe's container must be
   * started with. Always includes NOOPOLIS_RUN_ID (see
   * src/runtime/common.ts) when a run id is available, so every authority
   * container stamps causal events with the same run_id — never a value
   * read from model output.
   */
  env: Record<string, string>;
  runtimeName: string;
  runtimeRoot: string;
}

/**
 * Builds the shared container env assembly injected into every generated
 * runtime install recipe. Currently just NOOPOLIS_RUN_ID, sourced from the
 * host/compile process environment; omitted entirely when unset rather
 * than stamping an empty value.
 */
export const createRuntimeContainerEnv = (
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> => {
  const runId = resolveNoopolisRunId(env);
  return runId ? { [NOOPOLIS_RUN_ID_ENV]: runId } : {};
};

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

const resolveRuntimeImageRef = (
  envName: string,
  selection: Awaited<ReturnType<typeof resolveRuntimeInstallSelection>>
): string | undefined =>
  process.env[envName]?.trim() ||
  (selection.kind === "container_image"
    ? `${selection.image}:${selection.tag}`
    : undefined);

export interface RuntimeInstallRecipeOptions {
  /**
   * Compile-time-only local overrides for this runtime's install npm
   * packages (see src/runtime/containerPackageOverrides.ts and
   * src/compiler/containerPackageOverrides.ts). Never set during a
   * standard compile; only opt-in local/E2E harnesses populate this, and
   * only for the exact package names they override — every other package
   * in the recipe keeps its pinned registry `name@version` spec.
   */
  packageOverrides?: RuntimeContainerPackageOverrides;
}

export const createRuntimeInstallRecipe = async (
  runtimeName: string,
  options: RuntimeInstallRecipeOptions = {}
): Promise<RuntimeInstallRecipe> => {
  const selection = await resolveRuntimeInstallSelection(runtimeName);
  assertArtifactInstallSelection(runtimeName, selection);

  const installRoot = `${RUNTIME_INSTALL_ROOT}/${runtimeName}`;
  const containerEnv = createRuntimeContainerEnv();
  const packageOverrides = options.packageOverrides;

  switch (runtimeName) {
    case "openclaw": {
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
          `npm install -g --omit=dev --no-fund --no-audit ${selection.packageName}@${selection.version}`
        ],
        copyCommands: [],
        env: containerEnv,
        runtimeName,
        runtimeRoot: `/usr/local/lib/node_modules/${selection.packageName}`
      };
    }
    case "picoclaw": {
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

      const npmPackages = [
        resolveInstallPackageSpec(selection.packageName, selection.version, packageOverrides),
        resolveInstallPackageSpec(MNEME_PACKAGE_NAME, MNEME_PACKAGE_VERSION, packageOverrides),
        `${PI_CODING_AGENT_PACKAGE_NAME}@${PI_PACKAGE_VERSION}`,
        `${PI_AI_PACKAGE_NAME}@${PI_PACKAGE_VERSION}`
      ];

      return {
        commands: [
          `mkdir -p ${installRoot}`,
          `cd ${installRoot} && npm install --omit=dev --no-fund --no-audit ${npmPackages.join(" ")}`
        ],
        copyCommands: needsVendorCopyCommand(
          [selection.packageName, MNEME_PACKAGE_NAME],
          packageOverrides
        )
          ? [createVendorCopyCommand()]
          : [],
        env: containerEnv,
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
        resolveInstallPackageSpec(DAIMON_PACKAGE_NAME, DAIMON_PACKAGE_VERSION, packageOverrides),
        resolveInstallPackageSpec(MNEME_PACKAGE_NAME, MNEME_PACKAGE_VERSION, packageOverrides),
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
        copyCommands:
          !prebuiltBaseImage &&
          needsVendorCopyCommand([DAIMON_PACKAGE_NAME, MNEME_PACKAGE_NAME], packageOverrides)
            ? [createVendorCopyCommand()]
            : [],
        env: containerEnv,
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
