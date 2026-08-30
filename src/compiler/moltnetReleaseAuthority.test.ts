import { describe, expect, it } from "vitest";

import {
  MOLTNET_DUAL_BRIDGE_CAPABILITIES,
  parseMoltnetBridgeCapabilities,
  parseTrustedMoltnetReleaseAuthority,
  readTrustedMoltnetReleaseAuthority,
  trustedMoltnetReleaseAsset
} from "./moltnetReleaseAuthority.js";

describe("trusted Moltnet release authority", () => {
  it("loads the exact checked-in arm64 and amd64 pins", async () => {
    const authority = await readTrustedMoltnetReleaseAuthority();
    expect(authority).toMatchObject({
      version: "spawnfile.moltnet-release-authority.v1",
      release_version: "v0.1.18",
      source_revision: "988c5284f45705beb3bf59a4a4c0008605ce609e",
      capabilities: ["daimon-bridge", "pi-bridge"]
    });
    expect(trustedMoltnetReleaseAsset(authority, "arm64")).toMatchObject({
      asset: "moltnet_linux_arm64.tar.gz",
      asset_sha256: `sha256:${"40c1fae1c687a59a9e6d804ac28d00e925f318bd4e922accdca4402ceab88548"}`
    });
    expect(trustedMoltnetReleaseAsset(authority, "amd64")).toMatchObject({
      asset: "moltnet_linux_amd64.tar.gz",
      asset_sha256: `sha256:${"92d356cd33841e89b6bc56c6e8c2c37d987124f35c896d033e8766eab09da2c5"}`
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

  /**
   * The capability list is a UNION, never a replacement. moltnet v0.1.18
   * advertises both bridges, but every older pi-only release must keep pinning
   * cleanly — widening that rejects the old shape would strand every existing
   * pin.
   */
  it("still accepts a pi-only published release after the daimon widening", async () => {
    const authority = await readTrustedMoltnetReleaseAuthority();
    const piOnly = parseTrustedMoltnetReleaseAuthority({
      ...authority,
      release_version: "v0.1.14",
      source_revision: "7baeb284ba0b1b5e454476141a557d68b5a4af0d",
      capabilities: ["pi-bridge"]
    });
    expect(piOnly.capabilities).toEqual(["pi-bridge"]);
  });

  /**
   * CANONICAL ORDERING. Several consumers compare this list by exact equality
   * rather than as a set (`upReceipt.ts`, `localMoltnetAuthority.ts`), and the
   * local builder writes `daimon-bridge` first. A reordered-but-equivalent list
   * must be rejected rather than quietly accepted, or the two producers drift
   * and a valid release starts failing to pin.
   */
  it("pins one canonical capability ordering and rejects any other", async () => {
    const authority = await readTrustedMoltnetReleaseAuthority();
    expect(MOLTNET_DUAL_BRIDGE_CAPABILITIES).toEqual(["daimon-bridge", "pi-bridge"]);
    expect(authority.capabilities).toEqual([...MOLTNET_DUAL_BRIDGE_CAPABILITIES]);
    expect(parseMoltnetBridgeCapabilities(["daimon-bridge", "pi-bridge"])).toEqual(["daimon-bridge", "pi-bridge"]);
    for (const rejected of [
      ["pi-bridge", "daimon-bridge"],
      ["daimon-bridge"],
      ["pi-bridge", "pi-bridge"],
      ["daimon-bridge", "pi-bridge", "extra"],
      [],
      "pi-bridge"
    ]) {
      expect(parseMoltnetBridgeCapabilities(rejected)).toBeNull();
      expect(() => parseTrustedMoltnetReleaseAuthority({ ...authority, capabilities: rejected })).toThrow();
    }
  });
});
