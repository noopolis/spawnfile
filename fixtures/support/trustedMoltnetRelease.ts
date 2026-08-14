import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type {
  MoltnetReleaseIdentity,
  MoltnetTargetArchitecture
} from "../../src/compiler/moltnetBinaries.js";
import type { TrustedMoltnetReleaseAuthority } from
  "../../src/compiler/moltnetReleaseAuthority.js";

const ASSET_BASE64 =
  "H4sIAMhDdWoAA+3STQ7CIBAFYNY9xRjXluFnynmqoWkTC6ZQz29jSRcm6kZijHybt5nAI0PNWXaIaIjgns2aKPWaCQiSiqQWRiCgkMIQA8pfjbE5xHZaqrSXyYbRD8/mlrGue3FOeseWP6Lmoz9HZ2PGO97uX+uH/asGFQPM2Gnz5/vf7/gcJn4cHLfuCqGv7Kn3kD7FIdoQq293LIqiKD7vBticJfwACgAA";
const ASSET_SHA256 =
  "sha256:862abbf4e2919354c1ce98386945e3d7bc67d06c11f2cb1eb25c487f68de0d24" as const;

export const TRUSTED_TEST_MOLTNET_RELEASE_AUTHORITY = Object.freeze({
  assets: Object.freeze([
    Object.freeze({
      architecture: "amd64" as const,
      asset: "moltnet_linux_amd64.tar.gz",
      asset_sha256: ASSET_SHA256
    }),
    Object.freeze({
      architecture: "arm64" as const,
      asset: "moltnet_linux_arm64.tar.gz",
      asset_sha256: ASSET_SHA256
    })
  ]),
  capabilities: Object.freeze(["pi-bridge"] as const),
  release_version: "v0.0.1-1-g1111111",
  source_revision: "1".repeat(40),
  version: "spawnfile.moltnet-release-authority.v1" as const
}) satisfies TrustedMoltnetReleaseAuthority;

const execFile = promisify(execFileCallback);

export const stageTrustedTestMoltnetRelease = async (
  outputDirectory: string,
  options: { readonly architecture?: MoltnetTargetArchitecture } | undefined
): Promise<MoltnetReleaseIdentity> => {
  const architecture = options?.architecture
    ?? (process.arch === "arm64" ? "arm64" : "amd64");
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-trusted-test-release-"));
  const asset = `moltnet_linux_${architecture}.tar.gz`;
  try {
    await writeFile(path.join(directory, asset), Buffer.from(ASSET_BASE64, "base64"));
    await writeFile(
      path.join(directory, `moltnet_release_stamp_${architecture}.json`),
      `${JSON.stringify({
        arch: architecture,
        asset,
        built_at: "2026-08-07T00:00:00.000Z",
        capabilities: ["pi-bridge"],
        pi_bridge: true,
        sha256: ASSET_SHA256.slice("sha256:".length),
        source_revision: TRUSTED_TEST_MOLTNET_RELEASE_AUTHORITY.source_revision,
        stamp_version: "spawnfile.moltnet-release-stamp.v1",
        version: TRUSTED_TEST_MOLTNET_RELEASE_AUTHORITY.release_version
      })}\n`
    );
    const installDirectory = path.join(outputDirectory, "moltnet-bin");
    await mkdir(installDirectory, { recursive: true });
    await execFile("tar", [
      "-C", installDirectory, "-xzf", path.join(directory, asset)
    ]);
    await chmod(path.join(installDirectory, "moltnet"), 0o755);
    return Object.freeze({
      architecture,
      asset,
      asset_sha256: ASSET_SHA256,
      capabilities: Object.freeze(["pi-bridge"] as const),
      release_version: TRUSTED_TEST_MOLTNET_RELEASE_AUTHORITY.release_version,
      source_revision: TRUSTED_TEST_MOLTNET_RELEASE_AUTHORITY.source_revision,
      version: "spawnfile.moltnet-release-identity.v1" as const
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};
