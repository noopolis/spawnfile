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

const execFile = promisify(execFileCallback);

const temporaryDirectories: string[] = [];

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

const createFakeReleaseDirectory = async (): Promise<string> => {
  const directory = await createTempDirectory("spawnfile-moltnet-release-");
  const payloadDirectory = path.join(directory, "payload");
  await ensureDirectory(payloadDirectory);

  for (const binaryName of ["moltnet", "moltnet-node", "moltnet-bridge"]) {
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

  it("extracts the local Moltnet Linux release asset into the compile output", async () => {
    const releaseDirectory = await createFakeReleaseDirectory();
    const outputDirectory = await createTempDirectory("spawnfile-moltnet-out-");
    vi.stubEnv("SPAWNFILE_MOLTNET_RELEASE_DIR", releaseDirectory);

    await stageMoltnetBinaries(outputDirectory);

    for (const binaryName of ["moltnet", "moltnet-node", "moltnet-bridge"]) {
      const binaryPath = path.join(outputDirectory, MOLTNET_BIN_DIRECTORY, binaryName);
      await expect(fileExists(binaryPath)).resolves.toBe(true);
      await expect(readUtf8File(binaryPath)).resolves.toContain(binaryName);
    }
  });
});
