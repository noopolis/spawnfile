import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import type { TrustedMoltnetReleaseAuthority } from "./moltnetReleaseAuthority.js";
import {
  downloadTrustedMoltnetReleaseAsset,
  trustedMoltnetReleaseDownloadUrl
} from "./moltnetReleaseDownload.js";

const authorityFor = (bytes: Uint8Array): TrustedMoltnetReleaseAuthority => ({
  assets: [
    {
      architecture: "amd64",
      asset: "moltnet_linux_amd64.tar.gz",
      asset_sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`
    },
    {
      architecture: "arm64",
      asset: "moltnet_linux_arm64.tar.gz",
      asset_sha256: `sha256:${"a".repeat(64)}`
    }
  ],
  capabilities: ["pi-bridge"],
  release_version: "v0.1.14",
  source_revision: "7baeb284ba0b1b5e454476141a557d68b5a4af0d",
  version: "spawnfile.moltnet-release-authority.v1"
});

describe("trusted Moltnet release download", () => {
  it("derives only the pinned GitHub release URL", () => {
    const bytes = new TextEncoder().encode("release");
    expect(trustedMoltnetReleaseDownloadUrl(authorityFor(bytes), "amd64")).toBe(
      "https://github.com/noopolis/moltnet/releases/download/v0.1.14/moltnet_linux_amd64.tar.gz"
    );
  });

  it("writes exact digest-verified bytes and removes its temporary directory", async () => {
    const bytes = new TextEncoder().encode("trusted release bytes");
    const fetchRelease = vi.fn(async () => new Response(bytes, {
      headers: { "content-length": String(bytes.byteLength) },
      status: 200
    }));
    const downloaded = await downloadTrustedMoltnetReleaseAsset(
      authorityFor(bytes),
      "amd64",
      { fetchRelease }
    );
    await expect(readFile(downloaded.assetPath)).resolves.toEqual(Buffer.from(bytes));
    expect(fetchRelease).toHaveBeenCalledWith(
      "https://github.com/noopolis/moltnet/releases/download/v0.1.14/moltnet_linux_amd64.tar.gz",
      expect.objectContaining({ redirect: "follow", signal: expect.any(AbortSignal) })
    );
    await downloaded.cleanup();
    await expect(readFile(downloaded.assetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects HTTP failures, oversized responses, and digest drift", async () => {
    const bytes = new TextEncoder().encode("trusted release bytes");
    const authority = authorityFor(bytes);
    await expect(downloadTrustedMoltnetReleaseAsset(authority, "amd64", {
      fetchRelease: async () => new Response("missing", { status: 404, statusText: "Not Found" })
    })).rejects.toThrow(/HTTP 404 Not Found/u);
    await expect(downloadTrustedMoltnetReleaseAsset(authority, "amd64", {
      fetchRelease: async () => new Response("large", {
        headers: { "content-length": String(64 * 1024 * 1024 + 1) },
        status: 200
      })
    })).rejects.toThrow(/invalid content length/u);
    await expect(downloadTrustedMoltnetReleaseAsset(authority, "amd64", {
      fetchRelease: async () => new Response("different", { status: 200 })
    })).rejects.toThrow(/digest does not match/u);
  });
});
