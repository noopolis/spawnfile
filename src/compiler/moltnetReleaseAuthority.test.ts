import { describe, expect, it } from "vitest";

import {
  parseTrustedMoltnetReleaseAuthority,
  readTrustedMoltnetReleaseAuthority,
  trustedMoltnetReleaseAsset
} from "./moltnetReleaseAuthority.js";

describe("trusted Moltnet release authority", () => {
  it("loads the exact checked-in arm64 and amd64 pins", async () => {
    const authority = await readTrustedMoltnetReleaseAuthority();
    expect(authority).toMatchObject({
      version: "spawnfile.moltnet-release-authority.v1",
      release_version: "v0.1.14",
      source_revision: "7baeb284ba0b1b5e454476141a557d68b5a4af0d",
      capabilities: ["pi-bridge"]
    });
    expect(trustedMoltnetReleaseAsset(authority, "arm64")).toMatchObject({
      asset: "moltnet_linux_arm64.tar.gz",
      asset_sha256: `sha256:${"3d46ad047496dd32a9ad41901e7ae1f10a25e9a21f3b29d3b6ccd2cff62fa58f"}`
    });
    expect(trustedMoltnetReleaseAsset(authority, "amd64")).toMatchObject({
      asset: "moltnet_linux_amd64.tar.gz",
      asset_sha256: `sha256:${"a2e7a0acd44ab548a81d99e51401ebdee9f50a539b24c9450fc12d8e9218e5f6"}`
    });
  });

  it("rejects extra fields, missing architectures, and malformed revisions", async () => {
    const authority = await readTrustedMoltnetReleaseAuthority();
    for (const forged of [
      { ...authority, latest: true },
      { ...authority, assets: [authority.assets[0], authority.assets[0]] },
      { ...authority, source_revision: "f".repeat(39) }
    ]) expect(() => parseTrustedMoltnetReleaseAuthority(forged)).toThrow(
      /authority is invalid/u
    );
  });
});
