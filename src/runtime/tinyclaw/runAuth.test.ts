import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { ensureDirectory, removeDirectory, writeUtf8File } from "../../filesystem/index.js";

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
  it("covers model secrets when imported Claude and Codex auth are present", async () => {
    const profileDirectory = await createTempDirectory("spawnfile-tinyclaw-auth-");
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
      outputDirectory: "/tmp/out",
      tempRoot: "/tmp/auth"
    });

    expect(result).toEqual({
      coveredModelSecrets: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
      mountArgs: []
    });
  });

  it("does not cover secrets when matching env vars are already set", async () => {
    const profileDirectory = await createTempDirectory("spawnfile-tinyclaw-auth-");

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
      outputDirectory: "/tmp/out",
      tempRoot: "/tmp/auth"
    });

    expect(result).toEqual({
      coveredModelSecrets: [],
      mountArgs: []
    });
  });
});
