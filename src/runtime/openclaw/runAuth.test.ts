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

import { prepareOpenClawRuntimeAuth } from "./runAuth.js";

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

describe("prepareOpenClawRuntimeAuth", () => {
  it("materializes OpenClaw auth profiles and patches Codex provider models", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    const outputDirectory = await createTempDirectory("spawnfile-openclaw-out-");
    const tempRoot = await createTempDirectory("spawnfile-openclaw-run-");
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
          account_id: "acct-123",
          refresh_token: "codex-refresh"
        }
      })
    );

    const configPath =
      "/var/lib/spawnfile/instances/openclaw/agent-assistant/home/.openclaw/openclaw.json";
    const homePath = "/var/lib/spawnfile/instances/openclaw/agent-assistant/home";
    await createContainerConfig(outputDirectory, configPath, {
      agents: {
        defaults: {
          model: "openai/gpt-4.1",
          workspace: "/workspace"
        }
      }
    });

    const prepared = await prepareOpenClawRuntimeAuth({
      authProfile: await requireAuthProfile("dev"),
      env: {},
      instance: {
        config_path: configPath,
        home_path: homePath,
        id: "agent-assistant",
        model_auth_methods: {
          anthropic: "claude-code",
          openai: "codex"
        },
        model_secrets_required: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
        runtime: "openclaw"
      },
      outputDirectory,
      tempRoot
    });

    expect(prepared.coveredModelSecrets).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
    expect(prepared.mountArgs).toHaveLength(4);

    const authProfilesPath = getMountedHostPath(
      prepared.mountArgs,
      `${homePath}/.openclaw/agents/main/agent/auth-profiles.json`
    );
    await expect(readUtf8File(authProfilesPath)).resolves.toContain("\"anthropic:default\"");
    await expect(readUtf8File(authProfilesPath)).resolves.toContain("\"openai-codex:default\"");

    const patchedConfigPath = getMountedHostPath(prepared.mountArgs, configPath);
    const patchedConfig = await readUtf8File(patchedConfigPath);
    expect(patchedConfig).toContain("\"model\": \"openai-codex/gpt-4.1\"");
    expect(patchedConfig).toContain("\"openai-codex:default\"");
    expect(patchedConfig).toContain("\"provider\": \"openai-codex\"");
  });

  it("normalizes gpt-5 to OpenClaw's supported Codex model id", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    const outputDirectory = await createTempDirectory("spawnfile-openclaw-out-");
    const tempRoot = await createTempDirectory("spawnfile-openclaw-run-");
    process.env.SPAWNFILE_HOME = spawnfileHome;

    const codexImport = await registerImportedAuth("dev", "codex");
    await writeUtf8File(
      path.join(codexImport.directory, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: "codex-access",
          refresh_token: "codex-refresh"
        }
      })
    );

    const configPath =
      "/var/lib/spawnfile/instances/openclaw/agent-assistant/home/.openclaw/openclaw.json";
    await createContainerConfig(outputDirectory, configPath, {
      agents: {
        defaults: {
          model: "openai/gpt-5",
          workspace: "/workspace"
        }
      }
    });

    const prepared = await prepareOpenClawRuntimeAuth({
      authProfile: await requireAuthProfile("dev"),
      env: {},
      instance: {
        config_path: configPath,
        home_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home",
        id: "agent-assistant",
        model_auth_methods: {
          openai: "codex"
        },
        model_secrets_required: ["OPENAI_API_KEY"],
        runtime: "openclaw"
      },
      outputDirectory,
      tempRoot
    });

    const patchedConfigPath = getMountedHostPath(prepared.mountArgs, configPath);
    await expect(readUtf8File(patchedConfigPath)).resolves.toContain(
      "\"model\": \"openai-codex/gpt-5.4\""
    );
  });

  it("skips imported auth when env already satisfies the model secret", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    const outputDirectory = await createTempDirectory("spawnfile-openclaw-out-");
    const tempRoot = await createTempDirectory("spawnfile-openclaw-run-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    await setAuthProfileEnv("dev", { ANTHROPIC_API_KEY: "already-set" });

    const prepared = await prepareOpenClawRuntimeAuth({
      authProfile: await requireAuthProfile("dev"),
      env: { ANTHROPIC_API_KEY: "already-set" },
      instance: {
        config_path:
          "/var/lib/spawnfile/instances/openclaw/agent-assistant/home/.openclaw/openclaw.json",
        home_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home",
        id: "agent-assistant",
        model_auth_methods: {
          anthropic: "api_key"
        },
        model_secrets_required: ["ANTHROPIC_API_KEY"],
        runtime: "openclaw"
      },
      outputDirectory,
      tempRoot
    });

    expect(prepared).toEqual({
      coveredModelSecrets: [],
      mountArgs: []
    });
  });

  it("supports token-style Claude credentials and returns early without a runtime home", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    const outputDirectory = await createTempDirectory("spawnfile-openclaw-out-");
    const tempRoot = await createTempDirectory("spawnfile-openclaw-run-");
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

    const configPath =
      "/var/lib/spawnfile/instances/openclaw/agent-assistant/home/.openclaw/openclaw.json";
    await createContainerConfig(outputDirectory, configPath, {
      agents: {
        defaults: {
          model: "anthropic/claude-sonnet-4-5"
        }
      }
    });

    const prepared = await prepareOpenClawRuntimeAuth({
      authProfile: await requireAuthProfile("dev"),
      env: {},
      instance: {
        config_path: configPath,
        home_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home",
        id: "agent-assistant",
        model_auth_methods: {
          anthropic: "claude-code"
        },
        model_secrets_required: ["ANTHROPIC_API_KEY"],
        runtime: "openclaw"
      },
      outputDirectory,
      tempRoot
    });

    const authProfilesPath = getMountedHostPath(
      prepared.mountArgs,
      "/var/lib/spawnfile/instances/openclaw/agent-assistant/home/.openclaw/agents/main/agent/auth-profiles.json"
    );
    const authProfiles = await readUtf8File(authProfilesPath);
    expect(authProfiles).toContain("\"type\": \"token\"");
    expect(authProfiles).toContain("\"token\": \"claude-access\"");

    await expect(
      prepareOpenClawRuntimeAuth({
        authProfile: await requireAuthProfile("dev"),
        env: {},
        instance: {
          config_path: configPath,
          home_path: null,
          id: "agent-assistant",
          model_auth_methods: {
            anthropic: "claude-code"
          },
          model_secrets_required: ["ANTHROPIC_API_KEY"],
          runtime: "openclaw"
        },
        outputDirectory,
        tempRoot
      })
    ).resolves.toEqual({
      coveredModelSecrets: [],
      mountArgs: []
    });
  });
});
