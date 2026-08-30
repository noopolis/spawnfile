import { readFile } from "node:fs/promises";

import { SpawnfileError } from "../shared/index.js";

export const MOLTNET_RELEASE_AUTHORITY_VERSION =
  "spawnfile.moltnet-release-authority.v1" as const;
export type MoltnetTargetArchitecture = "amd64" | "arm64";

/**
 * The bridge capabilities a Moltnet build can advertise.
 *
 * CANONICAL ORDERING: `daimon-bridge` before `pi-bridge`. Several places
 * compare this list by exact equality (`upReceipt.ts`, `localMoltnetAuthority.ts`)
 * rather than as a set, so a differently ordered but equivalent list is
 * rejected as a different release. The local builder
 * (`scripts/build-local-moltnet.mjs`) already writes this order; every producer
 * must match it, and `moltnetReleaseAuthority.test.ts` asserts it.
 *
 * This is a UNION, never a replacement: an older pi-only release must keep
 * pinning cleanly after a dual-capability one is published.
 */
export const MOLTNET_PI_ONLY_CAPABILITIES = ["pi-bridge"] as const;
export const MOLTNET_DUAL_BRIDGE_CAPABILITIES = ["daimon-bridge", "pi-bridge"] as const;
export type MoltnetBridgeCapabilities =
  | typeof MOLTNET_PI_ONLY_CAPABILITIES
  | typeof MOLTNET_DUAL_BRIDGE_CAPABILITIES;

/**
 * The single runtime check for an advertised capability list. Every producer
 * and parser funnels through this so the type and the runtime check can never
 * drift apart — widening one without the other is precisely how a release
 * becomes typecheck-green and runtime-rejected.
 */
export const parseMoltnetBridgeCapabilities = (
  value: unknown
): MoltnetBridgeCapabilities | null => {
  if (!Array.isArray(value)) return null;
  const joined = value.join("\0");
  if (joined === MOLTNET_PI_ONLY_CAPABILITIES.join("\0")) return MOLTNET_PI_ONLY_CAPABILITIES;
  if (joined === MOLTNET_DUAL_BRIDGE_CAPABILITIES.join("\0")) return MOLTNET_DUAL_BRIDGE_CAPABILITIES;
  return null;
};

export interface TrustedMoltnetReleaseAsset {
  readonly architecture: MoltnetTargetArchitecture;
  readonly asset: string;
  readonly asset_sha256: `sha256:${string}`;
}

export interface TrustedMoltnetReleaseAuthority {
  readonly version: typeof MOLTNET_RELEASE_AUTHORITY_VERSION;
  readonly release_version: string;
  readonly source_revision: string;
  readonly capabilities: MoltnetBridgeCapabilities;
  readonly assets: readonly TrustedMoltnetReleaseAsset[];
}

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}$/u;
const VERSION = /^v?\d+\.\d+\.\d+(?:-\d+-g[a-f0-9]{7,40})?$/u;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const fail = (): never => {
  throw new SpawnfileError("compile_error", "Trusted Moltnet release authority is invalid");
};

export const parseTrustedMoltnetReleaseAuthority = (
  raw: unknown
): TrustedMoltnetReleaseAuthority => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const value = raw as Record<string, unknown>;
  if (!exactKeys(value, [
    "assets", "capabilities", "release_version", "source_revision", "version"
  ])
    || value.version !== MOLTNET_RELEASE_AUTHORITY_VERSION
    || typeof value.release_version !== "string"
    || !VERSION.test(value.release_version)
    || typeof value.source_revision !== "string"
    || !REVISION.test(value.source_revision)
    || parseMoltnetBridgeCapabilities(value.capabilities) === null
    || !Array.isArray(value.assets)
    || value.assets.length !== 2) return fail();
  const assets: TrustedMoltnetReleaseAsset[] = [];
  for (const rawAsset of value.assets) {
    if (!rawAsset || typeof rawAsset !== "object" || Array.isArray(rawAsset)) return fail();
    const asset = rawAsset as Record<string, unknown>;
    if (!exactKeys(asset, ["architecture", "asset", "asset_sha256"])
      || asset.architecture !== "amd64" && asset.architecture !== "arm64"
      || asset.asset !== `moltnet_linux_${asset.architecture}.tar.gz`
      || typeof asset.asset_sha256 !== "string"
      || !SHA256.test(asset.asset_sha256)) return fail();
    assets.push(Object.freeze({
      architecture: asset.architecture,
      asset: asset.asset,
      asset_sha256: asset.asset_sha256 as `sha256:${string}`
    }));
  }
  if (assets[0]?.architecture !== "amd64" || assets[1]?.architecture !== "arm64") return fail();
  const describedRevision = value.release_version.match(/-g([a-f0-9]{7,40})$/u)?.[1];
  if (describedRevision && !value.source_revision.startsWith(describedRevision)) return fail();
  return Object.freeze({
    version: MOLTNET_RELEASE_AUTHORITY_VERSION,
    release_version: value.release_version,
    source_revision: value.source_revision,
    capabilities: parseMoltnetBridgeCapabilities(value.capabilities)!,
    assets: Object.freeze(assets)
  });
};

export const readTrustedMoltnetReleaseAuthority = async (): Promise<
TrustedMoltnetReleaseAuthority
> => {
  try {
    return parseTrustedMoltnetReleaseAuthority(JSON.parse(
      await readFile(new URL("../../moltnet-releases.json", import.meta.url), "utf8")
    ));
  } catch (error) {
    if (error instanceof SpawnfileError) throw error;
    return fail();
  }
};

export const trustedMoltnetReleaseAsset = (
  authority: TrustedMoltnetReleaseAuthority,
  architecture: MoltnetTargetArchitecture
): TrustedMoltnetReleaseAsset => {
  const parsed = parseTrustedMoltnetReleaseAuthority(authority);
  const asset = parsed.assets.find((candidate) => candidate.architecture === architecture);
  return asset ?? fail();
};
