import { describe, expect, it } from "vitest";

import { isSpawnfileError } from "../shared/index.js";
import {
  decideLocalMoltnetStaging,
  ensureLocalMoltnetReleaseStaged,
  localMoltnetReleaseAssetName,
  localMoltnetReleaseStampName,
  MOLTNET_RELEASE_DIR_ENV
} from "./localMoltnetRelease.js";

const RELEASE_DIR = "/repo/ecosystem/moltnet/dist/release";
const ARCH = process.arch === "arm64" ? "arm64" : "amd64";
const ASSET = localMoltnetReleaseAssetName();
const STAMP = localMoltnetReleaseStampName();
const SHA = "a".repeat(64);
const REVISION = "a".repeat(40);
const TRUSTED_AUTHORITY = {
  version: "spawnfile.moltnet-release-authority.v1",
  release_version: "v0.1.14-1-gaaaaaaa",
  source_revision: REVISION,
  capabilities: ["pi-bridge"],
  assets: [
    {
      architecture: "amd64",
      asset: "moltnet_linux_amd64.tar.gz",
      asset_sha256: `sha256:${(ARCH === "amd64" ? SHA : "b".repeat(64))}`
    },
    {
      architecture: "arm64",
      asset: "moltnet_linux_arm64.tar.gz",
      asset_sha256: `sha256:${(ARCH === "arm64" ? SHA : "b".repeat(64))}`
    }
  ]
} as const;

const stamp = (changes: Record<string, unknown> = {}) => ({
  arch: ARCH,
  asset: ASSET,
  built_at: "2026-08-07T00:00:00.000Z",
  capabilities: ["pi-bridge"],
  pi_bridge: true,
  sha256: SHA,
  source_revision: REVISION,
  stamp_version: "spawnfile.moltnet-release-stamp.v1",
  version: "v0.1.14-1-gaaaaaaa",
  ...changes
});

const baseInput = {
  assetName: ASSET,
  assetPresent: true,
  assetSha256: SHA,
  configuredDir: undefined,
  releaseDir: RELEASE_DIR,
  stamp: stamp(),
  stampName: STAMP,
  trustedAuthority: TRUSTED_AUTHORITY
} as const;

describe("localMoltnetReleaseAssetName / stamp name", () => {
  it("names arch-specific linux artifacts for the host", () => {
    expect(localMoltnetReleaseAssetName()).toMatch(/^moltnet_linux_(amd64|arm64)\.tar\.gz$/u);
    expect(localMoltnetReleaseStampName()).toMatch(/^moltnet_release_stamp_(amd64|arm64)\.json$/u);
  });
});

describe("decideLocalMoltnetStaging", () => {
  it("stages when the tarball, a pi-bridge stamp, and a matching hash are all present", () => {
    expect(decideLocalMoltnetStaging({ ...baseInput })).toEqual({ action: "stage", releaseDir: RELEASE_DIR });
  });

  it("honors an explicit configured dir only with the same verified stamp", () => {
    expect(
      decideLocalMoltnetStaging({
        ...baseInput,
        configuredDir: "  /custom/release  "
      })
    ).toEqual({ action: "override", releaseDir: "/custom/release" });
  });

  it("throws naming the build command when the tarball is missing", () => {
    expect(() => decideLocalMoltnetStaging({ ...baseInput, assetPresent: false, assetSha256: undefined })).toThrow(
      /build:local-moltnet/u
    );
  });

  it("throws when the capability stamp is absent (stale pre-stamp build)", () => {
    try {
      decideLocalMoltnetStaging({ ...baseInput, stamp: undefined });
      throw new Error("expected throw");
    } catch (error) {
      expect(isSpawnfileError(error)).toBe(true);
      expect((error as Error).message).toContain("no capability stamp");
    }
  });

  it("throws when the stamp does not assert pi-bridge support", () => {
    expect(() => decideLocalMoltnetStaging({ ...baseInput, stamp: stamp({ pi_bridge: false }) })).toThrow(
      /pi-bridge-capable/u
    );
  });

  it("throws when the stamp sha256 does not match the tarball (stale pair)", () => {
    expect(() => decideLocalMoltnetStaging({ ...baseInput, stamp: stamp({ sha256: "b".repeat(64) }) })).toThrow(
      /sha256 does not match/u
    );
  });

  it("throws when the release version and source revision disagree", () => {
    expect(() => decideLocalMoltnetStaging({
      ...baseInput,
      stamp: stamp({ version: "v0.1.14-1-gbbbbbbb" })
    })).toThrow(/strict, pinned/u);
  });

  it("throws when a matching but malformed digest attempts to pass as provenance", () => {
    expect(() => decideLocalMoltnetStaging({
      ...baseInput,
      assetSha256: "not-a-digest",
      stamp: stamp({ sha256: "not-a-digest" })
    })).toThrow(/strict, pinned/u);
  });

  it("throws when a self-authored stamp and tarball are absent from trusted authority", () => {
    expect(() => decideLocalMoltnetStaging({
      ...baseInput,
      trustedAuthority: {
        ...TRUSTED_AUTHORITY,
        assets: TRUSTED_AUTHORITY.assets.map((asset) => asset.architecture === ARCH
          ? { ...asset, asset_sha256: `sha256:${"c".repeat(64)}` }
          : asset)
      }
    })).toThrow(/trusted pinned authority/u);
  });
});

describe("ensureLocalMoltnetReleaseStaged", () => {
  it("sets the release-dir env var when tarball + valid stamp + matching hash exist", async () => {
    const env: NodeJS.ProcessEnv = {};
    const releaseDir = await ensureLocalMoltnetReleaseStaged({
      env,
      fileExists: async () => true,
      readFile: async () => JSON.stringify(stamp()),
      readTrustedAuthority: async () => TRUSTED_AUTHORITY,
      releaseDir: RELEASE_DIR,
      sha256OfFile: async () => SHA
    });

    expect(releaseDir).toBe(RELEASE_DIR);
    expect(env[MOLTNET_RELEASE_DIR_ENV]).toBe(RELEASE_DIR);
  });

  it("leaves a verified explicit env override untouched", async () => {
    const env: NodeJS.ProcessEnv = { [MOLTNET_RELEASE_DIR_ENV]: "/custom/release" };
    const releaseDir = await ensureLocalMoltnetReleaseStaged({
      env,
      fileExists: async () => true,
      readFile: async () => JSON.stringify(stamp()),
      readTrustedAuthority: async () => TRUSTED_AUTHORITY,
      releaseDir: RELEASE_DIR,
      sha256OfFile: async () => SHA
    });

    expect(releaseDir).toBe("/custom/release");
    expect(env[MOLTNET_RELEASE_DIR_ENV]).toBe("/custom/release");
  });

  it("throws (and does not set the env var) when the stamp hash mismatches the tarball", async () => {
    const env: NodeJS.ProcessEnv = {};
    await expect(
      ensureLocalMoltnetReleaseStaged({
        env,
        fileExists: async () => true,
        readFile: async () => JSON.stringify(stamp({ sha256: "b".repeat(64) })),
        readTrustedAuthority: async () => TRUSTED_AUTHORITY,
        releaseDir: RELEASE_DIR,
        sha256OfFile: async () => SHA
      })
    ).rejects.toThrow(/sha256 does not match/u);
    expect(env[MOLTNET_RELEASE_DIR_ENV]).toBeUndefined();
  });

  it("throws when the tarball is missing", async () => {
    const env: NodeJS.ProcessEnv = {};
    await expect(
      ensureLocalMoltnetReleaseStaged({
        env,
        fileExists: async () => false,
        readFile: async () => "",
        readTrustedAuthority: async () => TRUSTED_AUTHORITY,
        releaseDir: RELEASE_DIR,
        sha256OfFile: async () => SHA
      })
    ).rejects.toThrow(/build:local-moltnet/u);
    expect(env[MOLTNET_RELEASE_DIR_ENV]).toBeUndefined();
  });
});
