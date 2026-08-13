import { createHash } from "node:crypto";
import { readFile as readFileBinary } from "node:fs/promises";
import path from "node:path";

import { fileExists, readUtf8File } from "../filesystem/index.js";
import { SpawnfileError } from "../shared/index.js";
import {
  parseTrustedMoltnetReleaseAuthority,
  readTrustedMoltnetReleaseAuthority,
  trustedMoltnetReleaseAsset,
  type TrustedMoltnetReleaseAuthority
} from "../compiler/moltnetReleaseAuthority.js";

/** The env var the compiler's `stageMoltnetBinaries` reads to source a local
 * Moltnet release dir instead of downloading the published release
 * (src/compiler/moltnetBinaries.ts). */
export const MOLTNET_RELEASE_DIR_ENV = "SPAWNFILE_MOLTNET_RELEASE_DIR";

/** Stable local release dir that `npm run build:local-moltnet` writes to;
 * matches ecosystem/moltnet's own `release-assets` Make target output. */
export const localMoltnetReleaseDir = (): string =>
  path.resolve(process.cwd(), "ecosystem", "moltnet", "dist", "release");

/** Maps the host arch to the Linux GOARCH the container build targets.
 * `stageMoltnetBinaries` defaults to the same native `process.arch`, so the
 * staged tarball must match it (arm64 on this box, amd64 on the 4090). */
export const localMoltnetArch = (): "amd64" | "arm64" => {
  switch (process.arch) {
    case "arm64":
      return "arm64";
    case "x64":
      return "amd64";
    default:
      throw new SpawnfileError(
        "runtime_error",
        `Local Moltnet staging does not support host architecture ${process.arch}`
      );
  }
};

export const localMoltnetReleaseAssetName = (): string =>
  `moltnet_linux_${localMoltnetArch()}.tar.gz`;

/** Companion capability stamp written next to the tarball by
 * build-local-moltnet.mjs; asserted below so a stale pre-pi-bridge same-arch
 * build cannot silently pass a mere existence check. */
export const localMoltnetReleaseStampName = (): string =>
  `moltnet_release_stamp_${localMoltnetArch()}.json`;

interface LocalMoltnetReleaseStamp {
  arch?: string;
  asset?: string;
  built_at?: string;
  capabilities?: unknown;
  pi_bridge?: boolean;
  sha256?: string;
  source_revision?: string;
  stamp_version?: string;
  version?: string;
}

export interface LocalMoltnetStagingDecision {
  action: "override" | "stage";
  releaseDir: string;
}

export interface DecideLocalMoltnetStagingInput {
  assetName: string;
  assetPresent: boolean;
  /** sha256 of the staged tarball, or undefined if it is absent. */
  assetSha256: string | undefined;
  configuredDir: string | undefined;
  releaseDir: string;
  /** Parsed capability stamp, or undefined if it is absent/unparseable. */
  stamp: LocalMoltnetReleaseStamp | undefined;
  stampName: string;
  trustedAuthority: TrustedMoltnetReleaseAuthority;
}

const buildCommandHint = (releaseDir: string, assetName: string): string =>
  `Build it once with: npm run build:local-moltnet (or set ${MOLTNET_RELEASE_DIR_ENV} to a release dir ` +
  `containing a pi-bridge-capable ${assetName}). Expected under ${releaseDir}.`;

/**
 * Pure decision for local-Moltnet staging, isolated from env/fs side effects
 * so it is unit-testable. Both an explicit configured dir and the local
 * checkout default must carry a capability stamp proving the artifact was built from
 * pi-bridge-supporting source and matching the tarball's current content hash
 * — the moltnet analog of `assertRuntimePackageOverrideDistsBuilt`, but
 * hardened past mere existence so a stale pre-pi-bridge build (which would
 * silently reintroduce the delivery bug) is rejected.
 */
export const decideLocalMoltnetStaging = (
  input: DecideLocalMoltnetStagingInput
): LocalMoltnetStagingDecision => {
  const configured = input.configuredDir?.trim();
  const effectiveReleaseDir = configured || input.releaseDir;
  const hint = buildCommandHint(effectiveReleaseDir, input.assetName);
  if (!input.assetPresent) {
    throw new SpawnfileError(
      "runtime_error",
      `Pi-supporting Moltnet release asset is missing (${path.join(effectiveReleaseDir, input.assetName)}). ` + hint
    );
  }
  if (!input.stamp) {
    throw new SpawnfileError(
      "runtime_error",
      `Moltnet release ${input.assetName} has no capability stamp (${path.join(effectiveReleaseDir, input.stampName)}); ` +
        `it may be a stale build that predates pi-bridge delivery. ${hint}`
    );
  }
  const keys = Object.keys(input.stamp).sort().join("\0");
  const architecture = input.assetName.match(/^moltnet_linux_(amd64|arm64)\.tar\.gz$/u)?.[1];
  const capabilities = input.stamp.capabilities;
  const describedRevision = input.stamp.version?.match(/-g([a-f0-9]{7,40})$/u)?.[1];
  if (keys !== ["arch", "asset", "built_at", "capabilities", "pi_bridge", "sha256",
    "source_revision", "stamp_version", "version"].sort().join("\0")
    || input.stamp.stamp_version !== "spawnfile.moltnet-release-stamp.v1"
    || input.stamp.arch !== architecture
    || input.stamp.asset !== input.assetName
    || typeof input.stamp.built_at !== "string"
    || !Number.isFinite(Date.parse(input.stamp.built_at))
    || !Array.isArray(capabilities)
    || capabilities.length !== 1
    || capabilities[0] !== "pi-bridge"
    || input.stamp.pi_bridge !== true
    || typeof input.stamp.sha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(input.stamp.sha256)
    || typeof input.stamp.source_revision !== "string"
    || !/^[a-f0-9]{40}$/u.test(input.stamp.source_revision)
    || typeof input.stamp.version !== "string"
    || !/^v?\d+\.\d+\.\d+(?:-\d+-g[a-f0-9]{7,40})?$/u.test(input.stamp.version)
    || Boolean(describedRevision && !input.stamp.source_revision?.startsWith(describedRevision))) {
    throw new SpawnfileError(
      "runtime_error",
      `Moltnet release stamp is not strict, pinned, and pi-bridge-capable. ${hint}`
    );
  }
  if (!input.stamp.sha256 || input.stamp.sha256 !== input.assetSha256) {
    throw new SpawnfileError(
      "runtime_error",
      `Local Moltnet release stamp sha256 does not match ${input.assetName} (stale or tampered stamp/tarball pair). ${hint}`
    );
  }
  const authority = parseTrustedMoltnetReleaseAuthority(input.trustedAuthority);
  const trustedAsset = trustedMoltnetReleaseAsset(
    authority,
    architecture as "amd64" | "arm64"
  );
  if (input.stamp.version !== authority.release_version
    || input.stamp.source_revision !== authority.source_revision
    || input.stamp.asset !== trustedAsset.asset
    || `sha256:${input.assetSha256}` !== trustedAsset.asset_sha256) {
    throw new SpawnfileError(
      "runtime_error",
      `Moltnet release stamp and tarball do not match trusted pinned authority. ${hint}`
    );
  }
  return { action: configured ? "override" : "stage", releaseDir: effectiveReleaseDir };
};

export interface EnsureLocalMoltnetReleaseDeps {
  env?: NodeJS.ProcessEnv;
  fileExists?: (filePath: string) => Promise<boolean>;
  readFile?: (filePath: string) => Promise<string>;
  readTrustedAuthority?: () => Promise<TrustedMoltnetReleaseAuthority>;
  releaseDir?: string;
  sha256OfFile?: (filePath: string) => Promise<string>;
}

const defaultSha256OfFile = async (filePath: string): Promise<string> =>
  createHash("sha256").update(await readFileBinary(filePath)).digest("hex");

const parseStamp = (raw: string): LocalMoltnetReleaseStamp | undefined => {
  try {
    return JSON.parse(raw) as LocalMoltnetReleaseStamp;
  } catch {
    return undefined;
  }
};

/**
 * Defaults `SPAWNFILE_MOLTNET_RELEASE_DIR` to this checkout's local Moltnet
 * release dir (asserting the arch tarball is built AND stamped pi-bridge-capable
 * with a matching content hash) so every pi-runtime e2e stages the pinned
 * pi-supporting Moltnet by default, with no per-run env. Verifies an explicit
 * `SPAWNFILE_MOLTNET_RELEASE_DIR` before leaving it untouched. Returns the release dir
 * in effect.
 */
export const ensureLocalMoltnetReleaseStaged = async (
  deps: EnsureLocalMoltnetReleaseDeps = {}
): Promise<string> => {
  const env = deps.env ?? process.env;
  const exists = deps.fileExists ?? fileExists;
  const readFile = deps.readFile ?? ((filePath: string) => readUtf8File(filePath));
  const sha256OfFile = deps.sha256OfFile ?? defaultSha256OfFile;
  const readTrustedAuthority = deps.readTrustedAuthority
    ?? readTrustedMoltnetReleaseAuthority;
  const defaultReleaseDir = deps.releaseDir ?? localMoltnetReleaseDir();
  const assetName = localMoltnetReleaseAssetName();
  const stampName = localMoltnetReleaseStampName();
  const configuredDir = env[MOLTNET_RELEASE_DIR_ENV];
  const releaseDir = configuredDir?.trim() || defaultReleaseDir;

  let assetPresent = false;
  let assetSha256: string | undefined;
  let stamp: LocalMoltnetReleaseStamp | undefined;
  const assetPath = path.join(releaseDir, assetName);
  const stampPath = path.join(releaseDir, stampName);
  assetPresent = await exists(assetPath);
  if (assetPresent) {
    assetSha256 = await sha256OfFile(assetPath);
  }
  if (await exists(stampPath)) {
    stamp = parseStamp(await readFile(stampPath));
  }

  const decision = decideLocalMoltnetStaging({
    assetName,
    assetPresent,
    assetSha256,
    configuredDir,
    releaseDir: defaultReleaseDir,
    stamp,
    stampName,
    trustedAuthority: await readTrustedAuthority()
  });

  if (decision.action === "stage") {
    env[MOLTNET_RELEASE_DIR_ENV] = decision.releaseDir;
  }
  return decision.releaseDir;
};
