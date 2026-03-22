import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { fileExists, readUtf8File, removeDirectory, writeUtf8File } from "../filesystem/index.js";

import {
  ensureAuthProfile,
  loadAuthProfile,
  registerImportedAuth,
  requireAuthProfile,
  setAuthProfileEnv
} from "./profileStore.js";

const temporaryDirectories: string[] = [];
const previousSpawnfileHome = process.env.SPAWNFILE_HOME;

const createTempSpawnfileHome = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-auth-home-"));
  temporaryDirectories.push(directory);
  process.env.SPAWNFILE_HOME = directory;
  return directory;
};

afterEach(async () => {
  if (previousSpawnfileHome === undefined) {
    delete process.env.SPAWNFILE_HOME;
  } else {
    process.env.SPAWNFILE_HOME = previousSpawnfileHome;
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("auth profile store", () => {
  it("creates and loads empty auth profiles", async () => {
    const home = await createTempSpawnfileHome();

    const profile = await ensureAuthProfile("dev");

    expect(profile.name).toBe("dev");
    expect(profile.env).toEqual({});
    expect(profile.imports).toEqual({});
    await expect(fileExists(path.join(home, "auth", "profiles", "dev", "profile.json"))).resolves.toBe(
      true
    );
    await expect(loadAuthProfile("dev")).resolves.toEqual(profile);
    await expect(requireAuthProfile("dev")).resolves.toEqual(profile);
    await expect(ensureAuthProfile("dev")).resolves.toEqual(profile);
  });

  it("merges env imports into the stored profile", async () => {
    await createTempSpawnfileHome();

    await setAuthProfileEnv("dev", { ANTHROPIC_API_KEY: "ant-key" });
    const profile = await setAuthProfileEnv("dev", {
      OPENAI_API_KEY: "openai-key"
    });

    expect(profile.env).toEqual({
      ANTHROPIC_API_KEY: "ant-key",
      OPENAI_API_KEY: "openai-key"
    });

    const stored = JSON.parse(await readUtf8File(profile.profilePath)) as { env: Record<string, string> };
    expect(stored.env).toEqual(profile.env);
  });

  it("registers imported auth directories and clears previous contents", async () => {
    await createTempSpawnfileHome();

    const initial = await registerImportedAuth("dev", "codex");
    await writeUtf8File(path.join(initial.directory, "auth.json"), "{\"token\":\"one\"}\n");

    const next = await registerImportedAuth("dev", "codex");

    expect(next.profile.imports.codex?.path).toBe(next.directory);
    await expect(fileExists(path.join(next.directory, "auth.json"))).resolves.toBe(false);
  });

  it("fails when a requested auth profile does not exist", async () => {
    await createTempSpawnfileHome();

    await expect(requireAuthProfile("missing")).rejects.toMatchObject({
      code: "validation_error",
      message: "Auth profile does not exist: missing"
    });
  });

  it("fails when a stored auth profile is invalid", async () => {
    const home = await createTempSpawnfileHome();
    const profilePath = path.join(home, "auth", "profiles", "broken", "profile.json");
    await ensureAuthProfile("broken");
    await writeUtf8File(profilePath, "{\n  \"version\": 2\n}\n");

    await expect(loadAuthProfile("broken")).rejects.toMatchObject({
      code: "validation_error"
    });
  });
});
