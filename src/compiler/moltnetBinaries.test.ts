import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, unlink } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureDirectory,
  fileExists,
  readUtf8File,
  removeDirectory,
  writeUtf8File
} from "../filesystem/index.js";

import {
  MOLTNET_BIN_DIRECTORY,
  resolveMoltnetCliCommand,
  stageMoltnetBinaries
} from "./moltnetBinaries.js";
import * as shippedMoltnetBinaries from "./moltnetBinaries.js";
import type { TrustedMoltnetReleaseAuthority } from "./moltnetReleaseAuthority.js";

const temporaryDirectories: string[] = [];
const execFile = promisify(execFileCallback);
const SOURCE_REVISION = "a".repeat(40);
const authorityOverride = vi.hoisted(() => ({
  current: undefined as TrustedMoltnetReleaseAuthority | undefined
}));

vi.mock("./moltnetReleaseAuthority.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./moltnetReleaseAuthority.js")>();
  return {
    ...actual,
    readTrustedMoltnetReleaseAuthority: async () =>
      authorityOverride.current ?? actual.readTrustedMoltnetReleaseAuthority()
  };
});

const createTempDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

const createFakeMoltnetCli = async (): Promise<string> => {
  const directory = await createTempDirectory("spawnfile-moltnet-cli-");
  const cliPath = path.join(directory, "moltnet");
  await writeUtf8File(
    cliPath,
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'version') {",
      "  process.stdout.write('0.0.0-test\\n');",
      "  process.exit(0);",
      "}",
      "process.stderr.write(`unexpected args: ${args.join(' ')}\\n`);",
      "process.exit(1);"
    ].join("\n") + "\n"
  );
  await chmod(cliPath, 0o755);
  return cliPath;
};

const createFakeReleaseDirectory = async (
  binaryNames: string[] = ["moltnet"],
  architecture = process.arch === "arm64" ? "arm64" : "amd64"
): Promise<string> => {
  const directory = await createTempDirectory("spawnfile-moltnet-release-");
  const payloadDirectory = path.join(directory, "payload");
  await ensureDirectory(payloadDirectory);

  for (const binaryName of binaryNames) {
    const binaryPath = path.join(payloadDirectory, binaryName);
    await writeUtf8File(binaryPath, [
      "#!/usr/bin/env sh",
      "if [ \"$1\" = version ]; then echo moltnet; exit 0; fi",
      "if [ \"$1\" = node ]; then sleep 2; exit 0; fi",
      `echo ${binaryName}`,
      "exit 1"
    ].join("\n") + "\n");
    await chmod(binaryPath, 0o755);
  }

  const assetName = `moltnet_linux_${architecture}.tar.gz`;
  const assetPath = path.join(directory, assetName);
  await execFile("tar", ["-C", payloadDirectory, "-czf", assetPath, "."]);
  const sha256 = createHash("sha256").update(await readFile(assetPath)).digest("hex");
  await writeUtf8File(path.join(directory, `moltnet_release_stamp_${architecture}.json`), `${JSON.stringify({
    arch: architecture,
    asset: assetName,
    built_at: "2026-08-07T00:00:00.000Z",
    capabilities: ["pi-bridge"],
    pi_bridge: true,
    sha256,
    source_revision: SOURCE_REVISION,
    stamp_version: "spawnfile.moltnet-release-stamp.v1",
    version: "v0.1.14-1-gaaaaaaa"
  })}\n`);

  return directory;
};

const stampExistingAsset = async (directory: string, assetName: string, architecture: string): Promise<void> => {
  const sha256 = createHash("sha256").update(await readFile(path.join(directory, assetName))).digest("hex");
  await writeUtf8File(path.join(directory, `moltnet_release_stamp_${architecture}.json`), `${JSON.stringify({
    arch: architecture, asset: assetName, built_at: "2026-08-07T00:00:00.000Z",
    capabilities: ["pi-bridge"], pi_bridge: true, sha256, source_revision: SOURCE_REVISION,
    stamp_version: "spawnfile.moltnet-release-stamp.v1", version: "v0.1.14-1-gaaaaaaa"
  })}\n`);
};

const fakeAuthority = async (
  directory: string,
  architecture: "amd64" | "arm64"
): Promise<TrustedMoltnetReleaseAuthority> => {
  const exactDigest = createHash("sha256").update(await readFile(
    path.join(directory, `moltnet_linux_${architecture}.tar.gz`)
  )).digest("hex");
  return {
    version: "spawnfile.moltnet-release-authority.v1",
    release_version: "v0.1.14-1-gaaaaaaa",
    source_revision: SOURCE_REVISION,
    capabilities: ["pi-bridge"],
    assets: (["amd64", "arm64"] as const).map((candidate) => ({
      architecture: candidate,
      asset: `moltnet_linux_${candidate}.tar.gz`,
      asset_sha256: `sha256:${candidate === architecture
        ? exactDigest : (candidate === "amd64" ? "b" : "c").repeat(64)}`
    }))
  };
};

const stageFakeRelease = async (
  outputDirectory: string,
  releaseDirectory: string,
  architecture: "amd64" | "arm64"
) => {
  authorityOverride.current = await fakeAuthority(releaseDirectory, architecture);
  return stageMoltnetBinaries(outputDirectory, { architecture, releaseDirectory });
};

afterEach(async () => {
  authorityOverride.current = undefined;
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("moltnetBinaries", () => {
  it("exposes only the fixed-authority staging surface from the shipped module", () => {
    expect(Object.keys(shippedMoltnetBinaries).sort()).toEqual([
      "MOLTNET_ALLOW_LOCAL_E2E_ENV",
      "MOLTNET_BINARY_NAMES",
      "MOLTNET_BIN_DIRECTORY",
      "MOLTNET_LOCAL_RELEASE_DIR_ENV",
      "MOLTNET_RELEASE_DIR_ENV",
      "MOLTNET_RELEASE_IDENTITY_VERSION",
      "MOLTNET_RELEASE_STAMP_VERSION",
      "resolveMoltnetCliCommand",
      "stageMoltnetBinaries"
    ]);
  });

  it("resolves a compiled Moltnet CLI from the environment", async () => {
    const cliPath = await createFakeMoltnetCli();
    vi.stubEnv("SPAWNFILE_MOLTNET_CLI", cliPath);

    await expect(resolveMoltnetCliCommand()).resolves.toBe(cliPath);
  });

  it("resolves an installed Moltnet CLI from PATH before local dev fallbacks", async () => {
    const cliPath = await createFakeMoltnetCli();
    vi.stubEnv("SPAWNFILE_MOLTNET_CLI", "");
    vi.stubEnv("PATH", `${path.dirname(cliPath)}:${process.env.PATH ?? ""}`);

    await expect(resolveMoltnetCliCommand()).resolves.toBe("moltnet");
  });

  it("wraps invalid configured Moltnet CLI execution errors", async () => {
    const directory = await createTempDirectory("spawnfile-moltnet-bad-cli-");
    const cliPath = path.join(directory, "moltnet");
    await writeUtf8File(cliPath, "#!/usr/bin/env sh\nexit 17\n");
    await chmod(cliPath, 0o755);
    vi.stubEnv("SPAWNFILE_MOLTNET_CLI", cliPath);

    await expect(resolveMoltnetCliCommand()).rejects.toThrow(
      /Unable to execute compiled Moltnet CLI/
    );
  });

  it("extracts a configured Moltnet Linux release asset into the compile output", async () => {
    const releaseDirectory = await createFakeReleaseDirectory();
    const outputDirectory = await createTempDirectory("spawnfile-moltnet-out-");
    vi.stubEnv("SPAWNFILE_MOLTNET_RELEASE_DIR", releaseDirectory);

    await expect(stageFakeRelease(
      outputDirectory,
      releaseDirectory,
      process.arch === "arm64" ? "arm64" : "amd64"
    )).resolves.toMatchObject({
      capabilities: ["pi-bridge"],
      release_version: "v0.1.14-1-gaaaaaaa",
      source_revision: SOURCE_REVISION,
      version: "spawnfile.moltnet-release-identity.v1"
    });

    const binaryPath = path.join(outputDirectory, MOLTNET_BIN_DIRECTORY, "moltnet");
    await expect(fileExists(binaryPath)).resolves.toBe(true);
    await expect(readUtf8File(binaryPath)).resolves.toContain("moltnet");
  });

  it("accepts an explicit isolated directory without process-wide release state", async () => {
    const releaseDirectory = await createFakeReleaseDirectory();
    const outputDirectory = await createTempDirectory("spawnfile-moltnet-out-");
    const architecture = process.arch === "arm64" ? "arm64" : "amd64";
    vi.stubEnv("SPAWNFILE_MOLTNET_RELEASE_DIR", "");

    await expect(stageFakeRelease(outputDirectory, releaseDirectory, architecture))
      .resolves.toMatchObject({ architecture });
    expect(process.env.SPAWNFILE_MOLTNET_RELEASE_DIR).toBe("");
  });

  it("rejects a self-authored stamp and tarball that agree only with each other", async () => {
    const releaseDirectory = await createFakeReleaseDirectory();
    const outputDirectory = await createTempDirectory("spawnfile-moltnet-out-");
    vi.stubEnv("SPAWNFILE_MOLTNET_RELEASE_DIR", releaseDirectory);

    await expect(stageMoltnetBinaries(outputDirectory)).rejects.toThrow(
      /do not match trusted pinned authority/u
    );
    await expect(fileExists(path.join(outputDirectory, MOLTNET_BIN_DIRECTORY)))
      .resolves.toBe(false);
  });

  it("admits a dual-bridge local identity only through explicit E2E opt-in", async () => {
    const releaseDirectory = await createFakeReleaseDirectory();
    const architecture = process.arch === "arm64" ? "arm64" : "amd64";
    const asset = `moltnet_linux_${architecture}.tar.gz`;
    const sha256 = createHash("sha256").update(await readFile(path.join(releaseDirectory, asset))).digest("hex");
    await writeUtf8File(path.join(releaseDirectory, `local_moltnet_release_stamp_${architecture}.json`), `${JSON.stringify({
      arch: architecture, asset, capabilities: ["daimon-bridge", "pi-bridge"],
      development: { mode: "local-development", non_production: true, unsigned: true, unpublished: true },
      sha256, source_sha256: `sha256:${"f".repeat(64)}`,
      stamp_version: "spawnfile.local-moltnet-release-stamp.v1"
    })}\n`);
    const outputDirectory = await createTempDirectory("spawnfile-moltnet-local-out-");
    vi.stubEnv("SPAWNFILE_LOCAL_MOLTNET_RELEASE_DIR", releaseDirectory);
    await expect(stageMoltnetBinaries(outputDirectory, { architecture })).rejects.toThrow(/explicit SPAWNFILE_ALLOW_LOCAL_E2E=1/u);
    vi.stubEnv("SPAWNFILE_ALLOW_LOCAL_E2E", "1");
    await expect(stageMoltnetBinaries(outputDirectory, { architecture })).resolves.toMatchObject({
      capabilities: ["daimon-bridge", "pi-bridge"],
      development: { mode: "local-development", non_production: true, unsigned: true, unpublished: true },
      source_sha256: `sha256:${"f".repeat(64)}`
    });
  });

  it("rejects a dual-bridge stamp when the archived binary rejects Daimon configuration", async () => {
    const releaseDirectory = await createFakeReleaseDirectory();
    const architecture = process.arch === "arm64" ? "arm64" : "amd64";
    const asset = `moltnet_linux_${architecture}.tar.gz`;
    const binaryPath = path.join(releaseDirectory, "payload", "moltnet");
    await writeUtf8File(binaryPath, [
      "#!/usr/bin/env sh",
      "if [ \"$1\" = version ]; then echo moltnet; exit 0; fi",
      "if grep -q '\"kind\":\"daimon\"' \"$2\"; then echo unsupported >&2; exit 1; fi",
      "sleep 2"
    ].join("\n") + "\n");
    await chmod(binaryPath, 0o755);
    await execFile("tar", ["-C", path.join(releaseDirectory, "payload"), "-czf", path.join(releaseDirectory, asset), "."]);
    const sha256 = createHash("sha256").update(await readFile(path.join(releaseDirectory, asset))).digest("hex");
    await writeUtf8File(path.join(releaseDirectory, `local_moltnet_release_stamp_${architecture}.json`), `${JSON.stringify({
      arch: architecture, asset, capabilities: ["daimon-bridge", "pi-bridge"],
      development: { mode: "local-development", non_production: true, unsigned: true, unpublished: true },
      sha256, source_sha256: `sha256:${"f".repeat(64)}`,
      stamp_version: "spawnfile.local-moltnet-release-stamp.v1"
    })}\n`);
    const outputDirectory = await createTempDirectory("spawnfile-moltnet-local-out-");
    vi.stubEnv("SPAWNFILE_LOCAL_MOLTNET_RELEASE_DIR", releaseDirectory);
    vi.stubEnv("SPAWNFILE_ALLOW_LOCAL_E2E", "1");

    await expect(stageMoltnetBinaries(outputDirectory, { architecture })).rejects.toThrow(/does not accept daimon-bridge/u);
  });

  it("rejects malformed local identities before extraction", async () => {
    const releaseDirectory = await createFakeReleaseDirectory();
    const architecture = process.arch === "arm64" ? "arm64" : "amd64";
    const asset = `moltnet_linux_${architecture}.tar.gz`;
    const sha256 = createHash("sha256").update(await readFile(path.join(releaseDirectory, asset))).digest("hex");
    await writeUtf8File(path.join(releaseDirectory, `local_moltnet_release_stamp_${architecture}.json`), `${JSON.stringify({
      arch: architecture, asset, capabilities: ["pi-bridge"],
      development: { mode: "local-development", non_production: true, unsigned: true, unpublished: true },
      sha256, source_sha256: `sha256:${"f".repeat(64)}`,
      stamp_version: "spawnfile.local-moltnet-release-stamp.v1"
    })}\n`);
    vi.stubEnv("SPAWNFILE_ALLOW_LOCAL_E2E", "1");
    vi.stubEnv("SPAWNFILE_LOCAL_MOLTNET_RELEASE_DIR", releaseDirectory);
    const outputDirectory = await createTempDirectory("spawnfile-moltnet-local-out-");
    await expect(stageMoltnetBinaries(outputDirectory, { architecture })).rejects.toThrow(/dual-bridge/u);
    await expect(fileExists(path.join(outputDirectory, MOLTNET_BIN_DIRECTORY))).resolves.toBe(false);
  });

  it("normalizes every supported configured architecture before trust verification", async () => {
    for (const [configured, architecture] of [
      ["amd64", "amd64"], ["x86_64", "amd64"], ["x64", "amd64"],
      ["aarch64", "arm64"], ["arm64", "arm64"]
    ] as const) {
      const releaseDirectory = await createFakeReleaseDirectory(["moltnet"], architecture);
      const outputDirectory = await createTempDirectory("spawnfile-moltnet-out-");
      authorityOverride.current = await fakeAuthority(releaseDirectory, architecture);
      vi.stubEnv("SPAWNFILE_MOLTNET_RELEASE_DIR", releaseDirectory);
      vi.stubEnv("SPAWNFILE_MOLTNET_TARGET_ARCH", configured);

      await expect(stageMoltnetBinaries(outputDirectory))
        .resolves.toMatchObject({ architecture });
      await expect(fileExists(path.join(
        outputDirectory,
        MOLTNET_BIN_DIRECTORY,
        "moltnet"
      ))).resolves.toBe(true);
    }
  });

  it("rejects unsupported manual Moltnet architecture values", async () => {
    const releaseDirectory = await createFakeReleaseDirectory(["moltnet"], "amd64");
    const outputDirectory = await createTempDirectory("spawnfile-moltnet-out-");
    vi.stubEnv("SPAWNFILE_MOLTNET_RELEASE_DIR", releaseDirectory);
    vi.stubEnv("SPAWNFILE_MOLTNET_TARGET_ARCH", "armv7");

    await expect(stageMoltnetBinaries(outputDirectory)).rejects.toThrow(
      /Moltnet container installs do not support target architecture armv7/
    );
  });

  it("can stage a Moltnet release asset for an explicit target architecture", async () => {
    const releaseDirectory = await createFakeReleaseDirectory(["moltnet"], "amd64");
    const outputDirectory = await createTempDirectory("spawnfile-moltnet-out-");
    vi.stubEnv("SPAWNFILE_MOLTNET_RELEASE_DIR", releaseDirectory);

    await expect(
      stageFakeRelease(outputDirectory, releaseDirectory, "amd64")
    ).resolves.toMatchObject({ architecture: "amd64", capabilities: ["pi-bridge"] });

    const binaryPath = path.join(outputDirectory, MOLTNET_BIN_DIRECTORY, "moltnet");
    await expect(fileExists(binaryPath)).resolves.toBe(true);
  });

  it("rejects missing configured release directories and assets", async () => {
    const outputDirectory = await createTempDirectory("spawnfile-moltnet-out-");
    const missingDirectory = path.join(outputDirectory, "missing-release");
    vi.stubEnv("SPAWNFILE_MOLTNET_RELEASE_DIR", missingDirectory);

    await expect(stageMoltnetBinaries(outputDirectory)).rejects.toThrow(
      /Moltnet release directory .* does not exist/
    );

    const releaseDirectory = await createTempDirectory("spawnfile-moltnet-empty-release-");
    vi.stubEnv("SPAWNFILE_MOLTNET_RELEASE_DIR", releaseDirectory);

    await expect(stageMoltnetBinaries(outputDirectory)).rejects.toThrow(
      /Moltnet release asset .* does not exist/
    );
    await expect(stageMoltnetBinaries(outputDirectory, {
      releaseDirectory: "relative/release"
    })).rejects.toThrow(/Trusted Moltnet release directory is invalid/u);
  });

  it("rejects corrupt or incomplete Moltnet release assets", async () => {
    const corruptReleaseDirectory = await createTempDirectory("spawnfile-moltnet-corrupt-release-");
    const outputDirectory = await createTempDirectory("spawnfile-moltnet-out-");
    const assetName = `moltnet_linux_${process.arch === "arm64" ? "arm64" : "amd64"}.tar.gz`;
    await writeUtf8File(path.join(corruptReleaseDirectory, assetName), "not a tarball\n");
    await stampExistingAsset(
      corruptReleaseDirectory,
      assetName,
      process.arch === "arm64" ? "arm64" : "amd64"
    );
    vi.stubEnv("SPAWNFILE_MOLTNET_RELEASE_DIR", corruptReleaseDirectory);

    await expect(stageFakeRelease(
      outputDirectory,
      corruptReleaseDirectory,
      process.arch === "arm64" ? "arm64" : "amd64"
    )).rejects.toThrow(
      /Unable to extract Moltnet release asset/
    );

    const incompleteReleaseDirectory = await createFakeReleaseDirectory([]);
    vi.stubEnv("SPAWNFILE_MOLTNET_RELEASE_DIR", incompleteReleaseDirectory);

    await expect(stageFakeRelease(
      outputDirectory,
      incompleteReleaseDirectory,
      process.arch === "arm64" ? "arm64" : "amd64"
    )).rejects.toThrow(
      /did not contain moltnet/
    );
  });

  it("rejects missing, stale, unpinned, or capability-mismatched stamps before extraction", async () => {
    const releaseDirectory = await createFakeReleaseDirectory();
    const outputDirectory = await createTempDirectory("spawnfile-moltnet-out-");
    const architecture = process.arch === "arm64" ? "arm64" : "amd64";
    const stampPath = path.join(releaseDirectory, `moltnet_release_stamp_${architecture}.json`);
    vi.stubEnv("SPAWNFILE_MOLTNET_RELEASE_DIR", releaseDirectory);

    await unlink(stampPath);
    await expect(stageFakeRelease(outputDirectory, releaseDirectory, architecture))
      .rejects.toThrow(/has no required capability stamp/u);
    await stampExistingAsset(releaseDirectory, `moltnet_linux_${architecture}.tar.gz`, architecture);

    await writeUtf8File(stampPath, "{");
    await expect(stageFakeRelease(outputDirectory, releaseDirectory, architecture))
      .rejects.toThrow(/not valid JSON/u);

    await writeUtf8File(stampPath, JSON.stringify({ version: "latest" }));
    await expect(stageFakeRelease(outputDirectory, releaseDirectory, architecture))
      .rejects.toThrow(/strict, pinned/u);

    const assetName = `moltnet_linux_${architecture}.tar.gz`;
    const assetSha = createHash("sha256")
      .update(await readFile(path.join(releaseDirectory, assetName))).digest("hex");
    await writeUtf8File(stampPath, `${JSON.stringify({
      arch: architecture, asset: assetName, built_at: "2026-08-07T00:00:00.000Z",
      capabilities: ["messages"], pi_bridge: false, sha256: assetSha,
      source_revision: SOURCE_REVISION, stamp_version: "spawnfile.moltnet-release-stamp.v1",
      version: "v0.1.14-1-gaaaaaaa"
    })}\n`);
    await expect(stageFakeRelease(outputDirectory, releaseDirectory, architecture))
      .rejects.toThrow(/pi-bridge/u);

    await stampExistingAsset(releaseDirectory, assetName, architecture);
    await writeUtf8File(path.join(releaseDirectory, assetName), "tampered\n");
    await expect(stageFakeRelease(outputDirectory, releaseDirectory, architecture))
      .rejects.toThrow(/sha256 does not match/u);
  });
});
