import { lstat, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { removeDirectory } from "../filesystem/index.js";
import {
  cleanupDaimonLocalAutonomousCredentials,
  createDaimonLocalAutonomousCredentials
} from "./daimonLocalAutonomousCredentials.js";

const homeDirectories: string[] = [];
const credentialDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(credentialDirectories.splice(0).map((directory) => cleanupDaimonLocalAutonomousCredentials(directory)));
  await Promise.all(homeDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("Daimon local autonomous credentials", () => {
  it("creates nonempty exact-0600 fake sources beneath the real home directory", async () => {
    const credentials = await createDaimonLocalAutonomousCredentials();
    credentialDirectories.push(credentials.directory);

    expect(path.dirname(credentials.directory)).toBe(os.homedir());
    expect(path.basename(credentials.directory)).toMatch(/^\.spawnfile-daimon-local-autonomous-credentials-/u);
    expect((await lstat(credentials.directory)).mode & 0o777).toBe(0o700);
    expect(Object.keys(credentials.environment).sort()).toEqual([
      "SPAWNFILE_DAIMON_SOURCE_AGY_UNLOCK_SECRET",
      "SPAWNFILE_DAIMON_SOURCE_CODEX_AUTH",
      "SPAWNFILE_DAIMON_SOURCE_GROK_AUTH"
    ]);
    for (const source of Object.values(credentials.environment)) {
      const metadata = await lstat(source);
      expect(path.dirname(source)).toBe(credentials.directory);
      expect(metadata.isFile()).toBe(true);
      expect(metadata.size).toBeGreaterThan(0);
      expect(metadata.mode & 0o777).toBe(0o600);
    }
  });

  it("removes only its credential directory", async () => {
    const homeDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-daimon-credential-home-"));
    homeDirectories.push(homeDirectory);
    const credentials = await createDaimonLocalAutonomousCredentials(homeDirectory);

    await cleanupDaimonLocalAutonomousCredentials(credentials.directory);

    await expect(lstat(credentials.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(homeDirectory)).isDirectory()).toBe(true);
  });
});
