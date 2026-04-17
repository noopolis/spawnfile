import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp } from "node:fs/promises";
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

const temporaryDirectories: string[] = [];
const execFile = promisify(execFileCallback);

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
  binaryNames: string[] = ["moltnet"]
): Promise<string> => {
  const directory = await createTempDirectory("spawnfile-moltnet-release-");
  const payloadDirectory = path.join(directory, "payload");
  await ensureDirectory(payloadDirectory);

  for (const binaryName of binaryNames) {
    const binaryPath = path.join(payloadDirectory, binaryName);
    await writeUtf8File(binaryPath, `#!/usr/bin/env sh\necho ${binaryName}\n`);
    await chmod(binaryPath, 0o755);
  }

  const assetName = `moltnet_linux_${process.arch === "arm64" ? "arm64" : "amd64"}.tar.gz`;
  await execFile("tar", ["-C", payloadDirectory, "-czf", path.join(directory, assetName), "."]);

  return directory;
};

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("moltnetBinaries", () => {
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

  it("skips container binary staging when no local release directory is configured", async () => {
    const outputDirectory = await createTempDirectory("spawnfile-moltnet-out-");
    vi.stubEnv("SPAWNFILE_MOLTNET_RELEASE_DIR", "");

    await expect(stageMoltnetBinaries(outputDirectory)).resolves.toBe(false);
    await expect(fileExists(path.join(outputDirectory, MOLTNET_BIN_DIRECTORY))).resolves.toBe(
      false
    );
  });

  it("extracts a configured Moltnet Linux release asset into the compile output", async () => {
    const releaseDirectory = await createFakeReleaseDirectory();
    const outputDirectory = await createTempDirectory("spawnfile-moltnet-out-");
    vi.stubEnv("SPAWNFILE_MOLTNET_RELEASE_DIR", releaseDirectory);

    await expect(stageMoltnetBinaries(outputDirectory)).resolves.toBe(true);

    const binaryPath = path.join(outputDirectory, MOLTNET_BIN_DIRECTORY, "moltnet");
    await expect(fileExists(binaryPath)).resolves.toBe(true);
    await expect(readUtf8File(binaryPath)).resolves.toContain("moltnet");
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
  });

  it("rejects corrupt or incomplete Moltnet release assets", async () => {
    const corruptReleaseDirectory = await createTempDirectory("spawnfile-moltnet-corrupt-release-");
    const outputDirectory = await createTempDirectory("spawnfile-moltnet-out-");
    const assetName = `moltnet_linux_${process.arch === "arm64" ? "arm64" : "amd64"}.tar.gz`;
    await writeUtf8File(path.join(corruptReleaseDirectory, assetName), "not a tarball\n");
    vi.stubEnv("SPAWNFILE_MOLTNET_RELEASE_DIR", corruptReleaseDirectory);

    await expect(stageMoltnetBinaries(outputDirectory)).rejects.toThrow(
      /Unable to extract Moltnet release asset/
    );

    const incompleteReleaseDirectory = await createFakeReleaseDirectory([]);
    vi.stubEnv("SPAWNFILE_MOLTNET_RELEASE_DIR", incompleteReleaseDirectory);

    await expect(stageMoltnetBinaries(outputDirectory)).rejects.toThrow(
      /did not contain moltnet/
    );
  });
});
