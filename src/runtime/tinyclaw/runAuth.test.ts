import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureDirectory,
  readUtf8File,
  removeDirectory,
  writeUtf8File
} from "../../filesystem/index.js";

import { prepareTinyClawRuntimeAuth } from "./runAuth.js";

const temporaryDirectories: string[] = [];

const createTempDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("prepareTinyClawRuntimeAuth", () => {
  const createOutputConfig = async (
    directory: string,
    value: Record<string, unknown>
  ): Promise<void> => {
    const configPath = path.join(
      directory,
      "container",
      "rootfs",
      "var",
      "lib",
      "spawnfile",
      "instances",
      "tinyclaw",
      "tinyclaw-runtime",
      "tinyagi",
      "settings.json"
    );
    await ensureDirectory(path.dirname(configPath));
    await writeUtf8File(configPath, `${JSON.stringify(value, null, 2)}\n`);
  };

  it("covers model secrets when imported Claude and Codex auth are present", async () => {
    const profileDirectory = await createTempDirectory("spawnfile-tinyclaw-auth-");
    const outputDirectory = await createTempDirectory("spawnfile-tinyclaw-out-");
    const tempRoot = await createTempDirectory("spawnfile-tinyclaw-run-");
    const claudeDirectory = path.join(profileDirectory, "imports", "claude-code");
    const codexDirectory = path.join(profileDirectory, "imports", "codex");
    await ensureDirectory(claudeDirectory);
    await ensureDirectory(codexDirectory);
    await writeUtf8File(
      path.join(claudeDirectory, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "claude-access",
          expiresAt: 1_800_000_000_000,
          refreshToken: "claude-refresh"
        }
      })
    );
    await writeUtf8File(
      path.join(codexDirectory, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: "codex-access",
          refresh_token: "codex-refresh"
        }
      })
    );
    await createOutputConfig(outputDirectory, {
      agents: {
        writer: {
          model: "gpt-5.4",
          provider: "openai"
        }
      },
      models: {
        provider: "openai"
      }
    });

    const result = await prepareTinyClawRuntimeAuth({
      authProfile: {
        authHome: profileDirectory,
        env: {},
        imports: {
          "claude-code": {
            kind: "claude-code",
            path: claudeDirectory
          },
          codex: {
            kind: "codex",
            path: codexDirectory
          }
        },
        name: "dev",
        profileDirectory,
        profilePath: path.join(profileDirectory, "profile.json"),
        version: 1
      },
      env: {},
      instance: {
        config_path: "/var/lib/spawnfile/instances/tinyclaw/tinyclaw-runtime/tinyagi/settings.json",
        home_path: "/var/lib/spawnfile/instances/tinyclaw/tinyclaw-runtime/tinyagi",
        id: "tinyclaw-runtime",
        model_auth_methods: {
          anthropic: "claude-code",
          openai: "codex"
        },
        model_secrets_required: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
        runtime: "tinyclaw"
      },
      outputDirectory,
      tempRoot
    });

    expect(result.coveredModelSecrets).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
    expect(result.mountArgs).toHaveLength(6);
    const mountedSettingsPath = result.mountArgs[1]!.split(":")[0]!;
    const mountedSettings = JSON.parse(await readUtf8File(mountedSettingsPath));
    expect(mountedSettings.models).toEqual({ provider: "openai" });
    expect(mountedSettings.agents).toEqual({
      writer: {
        model: "gpt-5.4",
        provider: "openai"
      }
    });
    const mountedClaudePath = result.mountArgs[3]!.split(":")[0]!;
    expect(await readUtf8File(mountedClaudePath)).toContain("\"accessToken\":\"claude-access\"");
    const mountedCodexPath = result.mountArgs[5]!.split(":")[0]!;
    expect(await readUtf8File(mountedCodexPath)).toContain("\"access_token\":\"codex-access\"");
  });

  it("does not cover secrets when matching env vars are already set", async () => {
    const profileDirectory = await createTempDirectory("spawnfile-tinyclaw-auth-");
    const outputDirectory = await createTempDirectory("spawnfile-tinyclaw-out-");
    const tempRoot = await createTempDirectory("spawnfile-tinyclaw-run-");
    await createOutputConfig(outputDirectory, {
      agents: {
        writer: {
          model: "gpt-5.4",
          provider: "openai"
        }
      },
      models: {
        provider: "openai"
      }
    });

    const result = await prepareTinyClawRuntimeAuth({
      authProfile: {
        authHome: profileDirectory,
        env: {},
        imports: {},
        name: "dev",
        profileDirectory,
        profilePath: path.join(profileDirectory, "profile.json"),
        version: 1
      },
      env: {
        ANTHROPIC_API_KEY: "ant",
        OPENAI_API_KEY: "openai"
      },
      instance: {
        config_path: "/var/lib/spawnfile/instances/tinyclaw/tinyclaw-runtime/tinyagi/settings.json",
        home_path: "/var/lib/spawnfile/instances/tinyclaw/tinyclaw-runtime/tinyagi",
        id: "tinyclaw-runtime",
        model_auth_methods: {
          anthropic: "api_key",
          openai: "api_key"
        },
        model_secrets_required: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
        runtime: "tinyclaw"
      },
      outputDirectory,
      tempRoot
    });

    expect(result.coveredModelSecrets).toEqual([]);
    expect(result.mountArgs).toHaveLength(2);
  });
});
