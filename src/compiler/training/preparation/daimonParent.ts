import { SpawnfileError } from "../../../shared/index.js";
import {
  DAIMON_LOCAL_RUNTIME_IDENTITY_ENV,
  loadLocalDaimonRuntimeIdentity,
  type LocalDaimonRuntimeIdentity
} from "../../../runtime/index.js";
import type { TrainingImageBuild } from "./contract.js";

/**
 * The declared native parent (`image.build.nativeImage`) and the attested local
 * Daimon runtime identity (`SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY`) are two
 * independent pointers at one composed run, and they are never the same digest:
 * `runtime-images/daimon/Dockerfile` ends in `FROM scratch`, so the identity can
 * only ever attest a *scratch* image that a runnable native parent copies
 * `/opt/spawnfile/runtime-installs/daimon` out of. Nothing host-side can compare
 * the two digests, so the binding is by content: the capability receipt and
 * contract-manifest digest the identity attests must be the ones actually baked
 * into the declared parent. `src/runtime/container.ts` verifies exactly this for
 * a compiled organization image; this is the same check for a training image.
 */
export const DAIMON_RUNTIME_INSTALL_ROOT = "/opt/spawnfile/runtime-installs/daimon";

/** A native parent served by the attested loopback development registry is always a local build. */
const LOOPBACK_NATIVE_PARENT = /^127\.0\.0\.1:(?:[1-9]\d{0,4})\//u;
const FROM_NATIVE_IMAGE = /^FROM \$\{NATIVE_IMAGE\}.*$/mu;
/** Everything embedded in the single-quoted shell literals below must be inert. */
const SHELL_SAFE = /^[A-Za-z0-9 ._:@/=+,()~-]+$/u;

export interface TrainingDaimonParent {
  declarationPath: string;
  identity: LocalDaimonRuntimeIdentity;
  identityPath: string;
  nativeImage: string;
}

const refuse = (lines: string[]): never => {
  throw new SpawnfileError("validation_error", lines.join("\n"));
};

const safe = (label: string, value: string): string => {
  if (!SHELL_SAFE.test(value)) {
    refuse([
      `Training cannot bind its native parent to a local Daimon runtime identity: ${label} contains characters that cannot be embedded in the image recipe.`,
      `  ${label} = ${JSON.stringify(value)}`
    ]);
  }
  return value;
};

/**
 * Resolves the identity that must match the declared native parent. Runs before
 * any Docker call, so an absent, stale-pinned or architecture-drifted identity
 * refuses the run — including `--dry-run` — before a container or a token is spent.
 */
export const resolveTrainingDaimonParent = async (
  build: TrainingImageBuild,
  declarationPath: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<TrainingDaimonParent | undefined> => {
  const identityPath = env[DAIMON_LOCAL_RUNTIME_IDENTITY_ENV]?.trim();
  if (!identityPath) {
    if (LOOPBACK_NATIVE_PARENT.test(build.nativeImage)) {
      refuse([
        "Training refuses a locally built native parent with no attested Daimon runtime identity.",
        `  ${declarationPath}  image.build.nativeImage = ${build.nativeImage}`,
        `  ${DAIMON_LOCAL_RUNTIME_IDENTITY_ENV} = (unset)`,
        `Point ${DAIMON_LOCAL_RUNTIME_IDENTITY_ENV} at the runtime identity written by the same rebuild that baked ${DAIMON_RUNTIME_INSTALL_ROOT} into that image.`
      ]);
    }
    return undefined;
  }
  // Keeps the existing contract-pin refusal: this is the first time a training
  // run applies it at all, and it stays exactly as strict as it already was.
  const identity = await loadLocalDaimonRuntimeIdentity(identityPath);
  const expected = build.platform === "linux/amd64" ? "amd64" : "arm64";
  if (identity.imageArchitecture !== expected) {
    refuse([
      "Training native parent and local Daimon runtime identity disagree on architecture.",
      `  ${declarationPath}  image.build.platform = ${build.platform}`,
      `  ${identityPath}  image_architecture = ${identity.imageArchitecture}`,
      "Rebuild both from one architecture, or repoint both at one rebuild."
    ]);
  }
  return {
    declarationPath: safe("the training declaration path", declarationPath),
    identity,
    identityPath: safe(DAIMON_LOCAL_RUNTIME_IDENTITY_ENV, identityPath),
    nativeImage: safe("image.build.nativeImage", build.nativeImage)
  };
};

/**
 * One `sh` command, executed as the first instruction of the `${NATIVE_IMAGE}`
 * stage, that refuses the build when the declared parent does not carry the exact
 * Daimon install the identity attests. This is the only place both values exist
 * in one process: the receipt lives inside the image, so no host-side read can
 * reach it without starting something.
 */
export const daimonParentVerificationScript = (parent: TrainingDaimonParent): string => {
  const receipt = `${DAIMON_RUNTIME_INSTALL_ROOT}/capability-receipt.json`;
  const manifest = `${DAIMON_RUNTIME_INSTALL_ROOT}/contract-manifest.sha256`;
  const report = [
    `printf '%s\\n'`,
    `'REFUSED: the declared training native parent does not carry the Daimon install its runtime identity attests.'`,
    `"  ${parent.declarationPath}  image.build.nativeImage = ${parent.nativeImage}"`,
    `"  ${parent.identityPath}  capability_receipt_sha256 = ${parent.identity.capabilityReceipt}"`,
    `"  ${parent.identityPath}  manifest_sha256 = ${parent.identity.manifestSha256}"`,
    `"  native parent ${receipt} = $found_receipt"`,
    `"  native parent ${manifest} = $found_manifest"`,
    `'Repoint image.build.nativeImage and ${DAIMON_LOCAL_RUNTIME_IDENTITY_ENV} at the same rebuild.'`,
    `>&2`
  ].join(" ");
  return [
    "set -u",
    `test -f '${receipt}' || { echo "REFUSED: ${parent.nativeImage} has no ${receipt}; it is not a Daimon native parent." >&2; exit 1; }`,
    `test -f '${manifest}' || { echo "REFUSED: ${parent.nativeImage} has no ${manifest}; it is not a Daimon native parent." >&2; exit 1; }`,
    `found_receipt="sha256:$(sha256sum '${receipt}' | cut -d' ' -f1)"`,
    `found_manifest="$(cat '${manifest}')"`,
    `if [ "$found_receipt" != '${parent.identity.capabilityReceipt}' ] || [ "$found_manifest" != '${parent.identity.manifestSha256}' ]; then ${report}; exit 1; fi`
  ].join("; ");
};

/**
 * Injects the verification as the first instruction of the native stage, so a
 * mismatched pair fails in seconds instead of after the whole distribution copy.
 * The recipe text is part of the image plan digest, so the identity is bound into
 * the training image's identity too — a rotated identity can never be cached over.
 */
export const bindDaimonParentVerification = (dockerfile: string, parent: TrainingDaimonParent): string => {
  if (!FROM_NATIVE_IMAGE.test(dockerfile)) {
    refuse([
      "Training recipe declares no ${NATIVE_IMAGE} stage, so its native parent cannot be bound to the Daimon runtime identity.",
      `  ${parent.identityPath}  image_reference = ${parent.identity.imageReference}`
    ]);
  }
  return dockerfile.replace(FROM_NATIVE_IMAGE, (line) => `${line}\nRUN ${daimonParentVerificationScript(parent)}`);
};
