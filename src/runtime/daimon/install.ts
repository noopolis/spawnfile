import { SpawnfileError } from "../../shared/index.js";

import type { RuntimeInstallRecipe } from "../container.js";
import type { NativeInstallRecipeInput, NativeInstallHintProfile } from "../containerRecipe.js";
import { createRuntimeImageCopyCommand } from "../containerRecipe.js";
import type { RuntimeInstallSelection } from "../install.js";
import type { DaimonCapabilityReceipts } from "../registry.js";
import { DAIMON_WAKE_FUSE_DIRECTORY, DAIMON_WAKE_FUSE_DIRECTORY_ENV } from "./config.js";
import { DAIMON_CONTRACT_MANIFEST_SHA256 } from "./contractManifest.js";
import { createDaimonInstallCommands } from "./daimonInstall.js";
import { DAIMON_LOCAL_RUNTIME_IDENTITY_ENV, loadLocalDaimonRuntimeIdentity } from "./localDaimonAuthority.js";

export const daimonInstallHints = {
  container_image: {
    ecosystem: "node",
    installHint: "Copy a pinned Daimon runtime image."
  },
  github_release_archive: {
    ecosystem: "node",
    installHint: "Download a pinned Daimon runtime release archive."
  },
  npm: {
    ecosystem: "node",
    installHint: "Install the pinned Daimon package and Pi SDK dependencies inside the generated runtime app."
  },
  source_repo: {
    ecosystem: "node",
    installHint: "Checkout the pinned Daimon repo ref and install from the repository root."
  }
} satisfies NativeInstallHintProfile;

const LEGACY_DAIMON_RUNTIME_IMAGE_ENV = "SPAWNFILE_DAIMON_RUNTIME_IMAGE";
const LEGACY_DAIMON_RUNTIME_CAPABILITY_RECEIPT_ENV =
  "SPAWNFILE_DAIMON_RUNTIME_CAPABILITY_RECEIPT";

/**
 * Daimon is distributed only as a generic, source-free runtime image. A
 * local-development authority is deliberately narrow: it must be an explicit
 * generated identity file naming the approved loopback registry repository by
 * manifest digest plus the exact embedded receipt digest. Raw image/receipt
 * overrides, mutable tags, checkouts, and host-installed CLIs are rejected.
 */
const resolveDaimonRuntimeImageRef = async (
  selection: RuntimeInstallSelection
): Promise<{ capabilityReceipt: string | DaimonCapabilityReceipts; image: string }> => {
  if (
    selection.kind !== "container_image" ||
    !selection.digest ||
    !(selection.capabilityReceipt || selection.capabilityReceipts)
  ) {
    throw new SpawnfileError(
      "runtime_error",
      "Daimon organization runtime v1 requires a pinned generic Daimon runtime image"
    );
  }

  const pinnedImage = `${selection.image}@${selection.digest}`;
  if (
    process.env[LEGACY_DAIMON_RUNTIME_IMAGE_ENV]?.trim() ||
    process.env[LEGACY_DAIMON_RUNTIME_CAPABILITY_RECEIPT_ENV]?.trim()
  ) {
    throw new SpawnfileError(
      "runtime_error",
      `Raw Daimon runtime image overrides are disabled; use ${DAIMON_LOCAL_RUNTIME_IDENTITY_ENV}`
    );
  }

  const identityPath = process.env[DAIMON_LOCAL_RUNTIME_IDENTITY_ENV]?.trim();
  if (identityPath) {
    const identity = await loadLocalDaimonRuntimeIdentity(identityPath);
    return { capabilityReceipt: identity.capabilityReceipt, image: identity.imageReference };
  }
  if (selection.contractManifestSha256 !== DAIMON_CONTRACT_MANIFEST_SHA256) {
    throw new SpawnfileError(
      "runtime_error",
      "Selected Daimon runtime image does not attest the compiler's exact contract manifest; build and select a matching local artifact or pin a published compatible release"
    );
  }
  return {
    capabilityReceipt: selection.capabilityReceipts ?? selection.capabilityReceipt as string,
    image: pinnedImage
  };
};

export const createDaimonInstallRecipe = async ({
  containerEnv,
  installRoot,
  runtimeName,
  selection
}: NativeInstallRecipeInput): Promise<RuntimeInstallRecipe> => {
  const daimonRuntime = await resolveDaimonRuntimeImageRef(selection);
  return {
    commands: createDaimonInstallCommands(installRoot, daimonRuntime.capabilityReceipt),
    copyCommands: [createRuntimeImageCopyCommand(daimonRuntime.image, installRoot)],
    env: {
      ...containerEnv,
      [DAIMON_WAKE_FUSE_DIRECTORY_ENV]: DAIMON_WAKE_FUSE_DIRECTORY
    },
    runtimeName,
    runtimeRoot: installRoot
  };
};
