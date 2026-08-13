import { readFile } from "node:fs/promises";

import { SpawnfileError } from "../shared/index.js";

export const MOLTNET_RELEASE_AUTHORITY_VERSION =
  "spawnfile.moltnet-release-authority.v1" as const;
export type MoltnetTargetArchitecture = "amd64" | "arm64";

export interface TrustedMoltnetReleaseAsset {
  readonly architecture: MoltnetTargetArchitecture;
  readonly asset: string;
  readonly asset_sha256: `sha256:${string}`;
}

export interface TrustedMoltnetReleaseAuthority {
  readonly version: typeof MOLTNET_RELEASE_AUTHORITY_VERSION;
  readonly release_version: string;
  readonly source_revision: string;
  readonly capabilities: readonly ["pi-bridge"];
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
    || !Array.isArray(value.capabilities)
    || value.capabilities.length !== 1
    || value.capabilities[0] !== "pi-bridge"
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
    capabilities: Object.freeze(["pi-bridge"] as const),
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
