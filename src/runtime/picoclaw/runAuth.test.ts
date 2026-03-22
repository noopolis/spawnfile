import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  registerImportedAuth,
  requireAuthProfile,
  setAuthProfileEnv
} from "../../auth/index.js";
import {
  ensureDirectory,
  readUtf8File,
  removeDirectory,
  writeUtf8File
} from "../../filesystem/index.js";

import { preparePicoClawRuntimeAuth } from "./runAuth.js";

const previousSpawnfileHome = process.env.SPAWNFILE_HOME;
const temporaryDirectories: string[] = [];

const createTempDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

const createContainerConfig = async (
  outputDirectory: string,
  configPath: string,
  content: Record<string, unknown>
): Promise<void> => {
  const hostPath = path.join(
    outputDirectory,
    "container",
    "rootfs",
    ...path.posix.relative("/", configPath).split("/")
  );
  await ensureDirectory(path.dirname(hostPath));
  await writeUtf8File(hostPath, `${JSON.stringify(content, null, 2)}\n`);
};

const getMountedHostPath = (mountArgs: string[], containerPath: string): string => {
  const mountIndex = mountArgs.findIndex((value) => value.endsWith(`:${containerPath}`));
  expect(mountIndex).toBeGreaterThanOrEqual(0);
  return mountArgs[mountIndex].slice(0, -1 * (containerPath.length + 1));
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
  it("writes PicoClaw auth.json and patches config to oauth auth methods", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    const outputDirectory = await createTempDirectory("spawnfile-picoclaw-out-");
    const tempRoot = await createTempDirectory("spawnfile-picoclaw-run-");
    process.env.SPAWNFILE_HOME = spawnfileHome;

    const claudeImport = await registerImportedAuth("dev", "claude-code");
    const codexImport = await registerImportedAuth("dev", "codex");
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
    await writeUtf8File(
      path.join(codexImport.directory, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: "codex-access",
          refresh_token: "codex-refresh"
        }
      })
    );

    const configPath = "/var/lib/spawnfile/instances/picoclaw/agent-router/picoclaw/config.json";
    const homePath = "/var/lib/spawnfile/instances/picoclaw/agent-router/picoclaw";
    await createContainerConfig(outputDirectory, configPath, {
      model_list: [
        {
          api_key: "file://secrets/ANTHROPIC_API_KEY",
          model: "anthropic/claude-sonnet-4",
          model_name: "claude-sonnet-4"
        },
        {
          api_key: "file://secrets/OPENAI_API_KEY",
          model: "openai/gpt-5",
          model_name: "gpt-5"
        }
      ]
    });

    const prepared = await preparePicoClawRuntimeAuth({
      authProfile: await requireAuthProfile("dev"),
      env: {},
      instance: {
        config_path: configPath,
        home_path: homePath,
        id: "agent-router",
        model_auth_methods: {
          anthropic: "claude-code",
          openai: "codex"
        },
        model_secrets_required: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
        runtime: "picoclaw"
      },
      outputDirectory,
      tempRoot
    });

    expect(prepared.coveredModelSecrets.sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY"
    ]);
    expect(prepared.mountArgs).toHaveLength(2);

    const mountedHomePath = getMountedHostPath(prepared.mountArgs, homePath);
    await expect(readUtf8File(path.join(mountedHomePath, "auth.json"))).resolves.toContain(
      "\"openai\""
    );
    await expect(readUtf8File(path.join(mountedHomePath, "auth.json"))).resolves.not.toContain(
      "\"anthropic\""
    );

    const patchedConfig = await readUtf8File(path.join(mountedHomePath, "config.json"));
    expect(patchedConfig).toContain("\"model\": \"claude-cli/claude-sonnet-4\"");
    expect(patchedConfig).toContain("\"auth_method\": \"oauth\"");
    expect(patchedConfig).not.toContain("\"api_key\": \"file://secrets/ANTHROPIC_API_KEY\"");
  });

  it("returns no mounts when imported auth is not needed", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    const outputDirectory = await createTempDirectory("spawnfile-picoclaw-out-");
    const tempRoot = await createTempDirectory("spawnfile-picoclaw-run-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    await setAuthProfileEnv("dev", {});

    const prepared = await preparePicoClawRuntimeAuth({
      authProfile: await requireAuthProfile("dev"),
      env: { OPENAI_API_KEY: "already-set" },
      instance: {
        config_path: "/var/lib/spawnfile/instances/picoclaw/agent-router/picoclaw/config.json",
        home_path: "/var/lib/spawnfile/instances/picoclaw/agent-router/picoclaw",
        id: "agent-router",
        model_auth_methods: {
          openai: "api_key"
        },
        model_secrets_required: ["OPENAI_API_KEY"],
        runtime: "picoclaw"
      },
      outputDirectory,
      tempRoot
    });

    expect(prepared).toEqual({
      coveredModelSecrets: [],
      mountArgs: []
    });
  });

  it("supports token-style Claude credentials and ignores non-object model_list entries", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    const outputDirectory = await createTempDirectory("spawnfile-picoclaw-out-");
    const tempRoot = await createTempDirectory("spawnfile-picoclaw-run-");
    process.env.SPAWNFILE_HOME = spawnfileHome;

    const claudeImport = await registerImportedAuth("dev", "claude-code");
    await writeUtf8File(
      path.join(claudeImport.directory, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "claude-access",
          expiresAt: 1_800_000_000_000
        }
      })
    );

    const configPath = "/var/lib/spawnfile/instances/picoclaw/agent-router/picoclaw/config.json";
    const homePath = "/var/lib/spawnfile/instances/picoclaw/agent-router/picoclaw";
    await createContainerConfig(outputDirectory, configPath, {
      model_list: [
        null,
        {
          api_key: "file://secrets/ANTHROPIC_API_KEY",
          model: "anthropic/claude-sonnet-4-5",
          model_name: "claude-sonnet-4-5"
        }
      ]
    });

    const prepared = await preparePicoClawRuntimeAuth({
      authProfile: await requireAuthProfile("dev"),
      env: {},
      instance: {
        config_path: configPath,
        home_path: homePath,
        id: "agent-router",
        model_auth_methods: {
          anthropic: "claude-code"
        },
        model_secrets_required: ["ANTHROPIC_API_KEY"],
        runtime: "picoclaw"
      },
      outputDirectory,
      tempRoot
    });

    const mountedHomePath = getMountedHostPath(prepared.mountArgs, homePath);
    const patchedConfig = await readUtf8File(path.join(mountedHomePath, "config.json"));
    expect(patchedConfig).toContain("\"model\": \"claude-cli/claude-sonnet-4-5\"");
    expect(patchedConfig).not.toContain("\"auth_method\": \"oauth\"");
    expect(patchedConfig).toContain("null");
    await expect(readUtf8File(path.join(mountedHomePath, "auth.json"))).rejects.toThrow();

    await expect(
      preparePicoClawRuntimeAuth({
        authProfile: await requireAuthProfile("dev"),
        env: {},
        instance: {
          config_path: configPath,
          home_path: null,
          id: "agent-router",
          model_auth_methods: {
            anthropic: "claude-code"
          },
          model_secrets_required: ["ANTHROPIC_API_KEY"],
          runtime: "picoclaw"
        },
        outputDirectory,
        tempRoot
      })
    ).resolves.toEqual({
      coveredModelSecrets: [],
      mountArgs: []
    });
  });

  it("normalizes dotted Claude model names for claude-cli", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    const outputDirectory = await createTempDirectory("spawnfile-picoclaw-out-");
    const tempRoot = await createTempDirectory("spawnfile-picoclaw-run-");
    process.env.SPAWNFILE_HOME = spawnfileHome;

    const claudeImport = await registerImportedAuth("dev", "claude-code");
    await writeUtf8File(
      path.join(claudeImport.directory, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "claude-access",
          expiresAt: 1_800_000_000_000
        }
      })
    );

    const configPath = "/var/lib/spawnfile/instances/picoclaw/agent-router/picoclaw/config.json";
    const homePath = "/var/lib/spawnfile/instances/picoclaw/agent-router/picoclaw";
    await createContainerConfig(outputDirectory, configPath, {
      model_list: [
        {
          api_key: "file://secrets/ANTHROPIC_API_KEY",
          model: "anthropic/claude-sonnet-4.6",
          model_name: "claude-sonnet-4.6"
        }
      ]
    });

    const prepared = await preparePicoClawRuntimeAuth({
      authProfile: await requireAuthProfile("dev"),
      env: {},
      instance: {
        config_path: configPath,
        home_path: homePath,
        id: "agent-router",
        model_auth_methods: {
          anthropic: "claude-code"
        },
        model_secrets_required: ["ANTHROPIC_API_KEY"],
        runtime: "picoclaw"
      },
      outputDirectory,
      tempRoot
    });

    const mountedHomePath = getMountedHostPath(prepared.mountArgs, homePath);
    const patchedConfig = await readUtf8File(path.join(mountedHomePath, "config.json"));
    expect(patchedConfig).toContain("\"model\": \"claude-cli/claude-sonnet-4-6\"");
  });
});
