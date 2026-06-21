import os from "node:os";
import path from "node:path";
import { mkdtemp, stat } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  registerImportedAuth,
  requireAuthProfile
} from "../../auth/index.js";
import {
  readUtf8File,
  removeDirectory,
  writeUtf8File
} from "../../filesystem/index.js";

import { preparePiRuntimeAuth } from "./runAuth.js";

const previousSpawnfileHome = process.env.SPAWNFILE_HOME;
const temporaryDirectories: string[] = [];

const createTempDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

const getMountedHostPath = (mountArgs: string[], containerPath: string): string => {
  const mountIndex = mountArgs.findIndex((value) => value.includes(`:${containerPath}`));
  expect(mountIndex).toBeGreaterThanOrEqual(0);
  return mountArgs[mountIndex].split(":")[0];
};

afterEach(async () => {
  if (previousSpawnfileHome === undefined) {
    delete process.env.SPAWNFILE_HOME;
  } else {
    process.env.SPAWNFILE_HOME = previousSpawnfileHome;
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("preparePiRuntimeAuth", () => {
  it("materializes Pi OpenAI Codex auth into the runtime home", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-pi-auth-home-");
    const tempRoot = await createTempDirectory("spawnfile-pi-run-");
    process.env.SPAWNFILE_HOME = spawnfileHome;

    const codexImport = await registerImportedAuth("dev", "codex");
    await writeUtf8File(
      path.join(codexImport.directory, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: "codex-access",
          account_id: "acct-123",
          refresh_token: "codex-refresh"
        }
      })
    );

    const homePath = "/var/lib/spawnfile/instances/pi/pi-app/home";
    const prepared = await preparePiRuntimeAuth({
      authProfile: await requireAuthProfile("dev"),
      env: {},
      instance: {
        config_path: "/var/lib/spawnfile/instances/pi/pi-app/pi/pi-app.json",
        home_path: homePath,
        id: "pi-app",
        model_auth_methods: {
          openai: "codex"
        },
        model_secrets_required: ["OPENAI_API_KEY"],
        runtime: "pi"
      },
      outputDirectory: "/tmp/out",
      tempRoot
    });

    expect(prepared.coveredModelSecrets).toEqual(["OPENAI_API_KEY"]);
    expect(prepared.mountArgs).toHaveLength(2);
    const hostAuthPath = getMountedHostPath(
      prepared.mountArgs,
      `${homePath}/.pi/agent/auth.json`
    );
    await expect(readUtf8File(hostAuthPath)).resolves.toContain('"openai-codex"');
    await expect(readUtf8File(hostAuthPath)).resolves.toContain('"accountId": "acct-123"');
    expect(prepared.mountArgs).toContain(`${hostAuthPath}:${homePath}/.pi/agent/auth.json`);
    expect((await stat(path.dirname(hostAuthPath))).mode & 0o777).toBe(0o700);
    expect((await stat(hostAuthPath)).mode & 0o777).toBe(0o644);
  });

  it("materializes Pi Anthropic auth from Claude Code imports", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-pi-auth-home-");
    const tempRoot = await createTempDirectory("spawnfile-pi-run-");
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

    const homePath = "/var/lib/spawnfile/instances/pi/pi-app/home";
    const prepared = await preparePiRuntimeAuth({
      authProfile: await requireAuthProfile("dev"),
      env: {},
      instance: {
        config_path: "/var/lib/spawnfile/instances/pi/pi-app/pi/pi-app.json",
        home_path: homePath,
        id: "pi-app",
        model_auth_methods: {
          anthropic: "claude-code"
        },
        model_secrets_required: ["ANTHROPIC_API_KEY"],
        runtime: "pi"
      },
      outputDirectory: "/tmp/out",
      tempRoot
    });

    expect(prepared.coveredModelSecrets).toEqual(["ANTHROPIC_API_KEY"]);
    const hostAuthPath = getMountedHostPath(
      prepared.mountArgs,
      `${homePath}/.pi/agent/auth.json`
    );
    await expect(readUtf8File(hostAuthPath)).resolves.toContain('"anthropic"');
    await expect(readUtf8File(hostAuthPath)).resolves.toContain('"refresh": "claude-refresh"');
  });

  it("skips auth preparation when the Pi instance does not use Codex auth", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-pi-auth-home-");
    const tempRoot = await createTempDirectory("spawnfile-pi-run-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    await registerImportedAuth("dev", "codex");

    const prepared = await preparePiRuntimeAuth({
      authProfile: await requireAuthProfile("dev"),
      env: {},
      instance: {
        config_path: "/var/lib/spawnfile/instances/pi/pi-app/pi/pi-app.json",
        home_path: "/var/lib/spawnfile/instances/pi/pi-app/home",
        id: "pi-app",
        model_auth_methods: {
          openai: "api_key"
        },
        model_secrets_required: ["OPENAI_API_KEY"],
        runtime: "pi"
      },
      outputDirectory: "/tmp/out",
      tempRoot
    });

    expect(prepared).toEqual({
      coveredModelSecrets: [],
      mountArgs: []
    });
  });

  it("skips auth preparation without a runtime home path", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-pi-auth-home-");
    const tempRoot = await createTempDirectory("spawnfile-pi-run-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    await registerImportedAuth("dev", "codex");

    const prepared = await preparePiRuntimeAuth({
      authProfile: await requireAuthProfile("dev"),
      env: {},
      instance: {
        config_path: "/var/lib/spawnfile/instances/pi/pi-app/pi/pi-app.json",
        home_path: null,
        id: "pi-app",
        model_auth_methods: {
          openai: "codex"
        },
        model_secrets_required: ["OPENAI_API_KEY"],
        runtime: "pi"
      },
      outputDirectory: "/tmp/out",
      tempRoot
    });

    expect(prepared).toEqual({
      coveredModelSecrets: [],
      mountArgs: []
    });
  });
});
