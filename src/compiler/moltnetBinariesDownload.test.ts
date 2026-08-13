import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fileExists } from "../filesystem/index.js";
import type { TrustedMoltnetReleaseAuthority } from "./moltnetReleaseAuthority.js";
import type { DownloadedMoltnetReleaseAsset } from "./moltnetReleaseDownload.js";
import { stageMoltnetBinaries } from "./moltnetBinaries.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const authorityOverride = vi.hoisted(() => ({
  current: undefined as TrustedMoltnetReleaseAuthority | undefined
}));
const downloadOverride = vi.hoisted(() => ({
  current: undefined as ((
    authority: TrustedMoltnetReleaseAuthority,
    architecture: "amd64" | "arm64"
  ) => Promise<DownloadedMoltnetReleaseAsset>) | undefined
}));

vi.mock("./moltnetReleaseAuthority.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./moltnetReleaseAuthority.js")>();
  return {
    ...actual,
    readTrustedMoltnetReleaseAuthority: async () => authorityOverride.current
      ?? actual.readTrustedMoltnetReleaseAuthority()
  };
});

vi.mock("./moltnetReleaseDownload.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./moltnetReleaseDownload.js")>();
  return {
    ...actual,
    downloadTrustedMoltnetReleaseAsset: (
      authority: TrustedMoltnetReleaseAuthority,
      architecture: "amd64" | "arm64"
    ) => downloadOverride.current?.(authority, architecture)
      ?? actual.downloadTrustedMoltnetReleaseAsset(authority, architecture)
  };
});

afterEach(async () => {
  authorityOverride.current = undefined;
  downloadOverride.current = undefined;
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Moltnet downloaded binary staging", () => {
  it("extracts the authority-pinned download when no local override exists", async () => {
    const architecture = process.arch === "arm64" ? "arm64" : "amd64";
    const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-moltnet-download-test-"));
    roots.push(root);
    const payload = path.join(root, "payload");
    const output = path.join(root, "output");
    await mkdir(payload);
    const binary = path.join(payload, "moltnet");
    await writeFile(binary, "#!/usr/bin/env sh\necho moltnet\n");
    await chmod(binary, 0o755);
    const asset = `moltnet_linux_${architecture}.tar.gz`;
    const assetPath = path.join(root, asset);
    await execFile("tar", ["-C", payload, "-czf", assetPath, "."]);
    const sha256 = createHash("sha256").update(await readFile(assetPath)).digest("hex");
    const authority: TrustedMoltnetReleaseAuthority = {
      assets: (["amd64", "arm64"] as const).map((candidate) => ({
        architecture: candidate,
        asset: `moltnet_linux_${candidate}.tar.gz`,
        asset_sha256: `sha256:${candidate === architecture ? sha256 : "a".repeat(64)}`
      })),
      capabilities: ["pi-bridge"],
      release_version: "v0.1.14",
      source_revision: "7baeb284ba0b1b5e454476141a557d68b5a4af0d",
      version: "spawnfile.moltnet-release-authority.v1"
    };
    const cleanup = vi.fn(async () => undefined);
    authorityOverride.current = authority;
    downloadOverride.current = async () => ({ assetPath, cleanup });
    vi.stubEnv("SPAWNFILE_MOLTNET_RELEASE_DIR", "");

    await expect(stageMoltnetBinaries(output, { architecture })).resolves.toMatchObject({
      architecture,
      asset_sha256: `sha256:${sha256}`,
      release_version: "v0.1.14"
    });
    await expect(fileExists(path.join(output, "moltnet-bin", "moltnet"))).resolves.toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
