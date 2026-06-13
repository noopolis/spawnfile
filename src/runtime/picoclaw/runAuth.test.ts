import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  registerImportedAuth,
  requireAuthProfile,
  setAuthProfileEnv
} from "../../auth/index.js";
import { removeDirectory, writeUtf8File } from "../../filesystem/index.js";

import { preparePicoClawRuntimeAuth } from "./runAuth.js";

const previousSpawnfileHome = process.env.SPAWNFILE_HOME;
const temporaryDirectories: string[] = [];

const createTempDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
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

describe("preparePicoClawRuntimeAuth", () => {
  const instance = (overrides: Record<string, unknown> = {}) => ({
    config_path:
      "/var/lib/spawnfile/instances/picoclaw/agent-router/picoclaw/config.json",
    home_path: "/var/lib/spawnfile/instances/picoclaw/agent-router/picoclaw",
    id: "agent-router",
    model_auth_methods: { anthropic: "claude-code" as const },
    model_secrets_required: [],
    runtime: "picoclaw",
    ...overrides
  });

  it("reports the covered model secret for Claude Code without mounting a patched home", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    const tempRoot = await createTempDirectory("spawnfile-picoclaw-run-");
    process.env.SPAWNFILE_HOME = spawnfileHome;

    const claudeImport = await registerImportedAuth("dev", "claude-code");
    await writeUtf8File(
      path.join(claudeImport.directory, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "claude-access",
          expiresAt: 1_800_000_000_000,
          refreshToken: "claude-refresh"
        }
      })
    );

    const prepared = await preparePicoClawRuntimeAuth({
      authProfile: await requireAuthProfile("dev"),
      env: {},
      instance: instance(),
      outputDirectory: "",
      tempRoot
    });

    // The claude-cli config is baked into the image at compile time, so run-time
    // auth only declares the covered secret; the credential import is mounted by
    // the caller. No source rootfs is read.
    expect(prepared.coveredModelSecrets).toEqual(["ANTHROPIC_API_KEY"]);
    expect(prepared.mountArgs).toEqual([]);
  });

  it("returns no mounts when the profile has no Claude Code import", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    const tempRoot = await createTempDirectory("spawnfile-picoclaw-run-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    await setAuthProfileEnv("dev", { ANTHROPIC_API_KEY: "already-set" });

    const prepared = await preparePicoClawRuntimeAuth({
      authProfile: await requireAuthProfile("dev"),
      env: { ANTHROPIC_API_KEY: "already-set" },
      instance: instance(),
      outputDirectory: "",
      tempRoot
    });

    expect(prepared).toEqual({ coveredModelSecrets: [], mountArgs: [] });
  });

  it("returns no mounts when the instance has no home path", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    const tempRoot = await createTempDirectory("spawnfile-picoclaw-run-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    await registerImportedAuth("dev", "claude-code");

    const prepared = await preparePicoClawRuntimeAuth({
      authProfile: await requireAuthProfile("dev"),
      env: {},
      instance: instance({ home_path: null }),
      outputDirectory: "",
      tempRoot
    });

    expect(prepared).toEqual({ coveredModelSecrets: [], mountArgs: [] });
  });
});
