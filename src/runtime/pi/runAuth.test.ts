import os from "node:os";
import path from "node:path";
import { mkdtemp, stat } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  registerImportedAuth,
  requireAuthProfile
} from "../../auth/index.js";
import {
  ensureDirectory,
  readUtf8File,
  removeDirectory,
  writeUtf8File
} from "../../filesystem/index.js";

import { preparePiRuntimeAuth } from "./runAuth.js";

const previousSpawnfileHome = process.env.SPAWNFILE_HOME;
const previousGrokHome = process.env.GROK_HOME;
const previousAntigravityHome = process.env.ANTIGRAVITY_HOME;
const previousAntigravityCliHome = process.env.ANTIGRAVITY_CLI_HOME;
const previousAgyHome = process.env.AGY_HOME;
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

const disableCliHomeDiscovery = (root: string): void => {
  process.env.GROK_HOME = path.join(root, "missing-grok");
  process.env.ANTIGRAVITY_HOME = path.join(root, "missing-antigravity");
  process.env.ANTIGRAVITY_CLI_HOME = path.join(root, "missing-antigravity-cli");
  delete process.env.AGY_HOME;
};

afterEach(async () => {
  if (previousSpawnfileHome === undefined) {
    delete process.env.SPAWNFILE_HOME;
  } else {
    process.env.SPAWNFILE_HOME = previousSpawnfileHome;
  }
  if (previousGrokHome === undefined) {
    delete process.env.GROK_HOME;
  } else {
    process.env.GROK_HOME = previousGrokHome;
  }
  if (previousAntigravityHome === undefined) {
    delete process.env.ANTIGRAVITY_HOME;
  } else {
    process.env.ANTIGRAVITY_HOME = previousAntigravityHome;
  }
  if (previousAntigravityCliHome === undefined) {
    delete process.env.ANTIGRAVITY_CLI_HOME;
  } else {
    process.env.ANTIGRAVITY_CLI_HOME = previousAntigravityCliHome;
  }
  if (previousAgyHome === undefined) {
    delete process.env.AGY_HOME;
  } else {
    process.env.AGY_HOME = previousAgyHome;
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("preparePiRuntimeAuth", () => {
  it("materializes Pi OpenAI Codex auth into the runtime home", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-pi-auth-home-");
    const tempRoot = await createTempDirectory("spawnfile-pi-run-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    disableCliHomeDiscovery(tempRoot);

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
    disableCliHomeDiscovery(tempRoot);

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
    disableCliHomeDiscovery(tempRoot);
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

  it("mounts explicit Grok and Antigravity CLI homes into the Pi runtime home", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-pi-auth-home-");
    const tempRoot = await createTempDirectory("spawnfile-pi-run-");
    const grokHome = await createTempDirectory("spawnfile-grok-home-");
    const antigravityHome = await createTempDirectory("spawnfile-agy-home-");
    const antigravityCliHome = await createTempDirectory("spawnfile-agy-cli-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    process.env.GROK_HOME = grokHome;
    process.env.ANTIGRAVITY_HOME = antigravityHome;
    process.env.ANTIGRAVITY_CLI_HOME = antigravityCliHome;
    await registerImportedAuth("dev", "codex");
    await writeUtf8File(path.join(grokHome, "version.json"), "{\"version\":\"test\"}\n");
    await writeUtf8File(path.join(grokHome, "auth.json"), "{\"token\":\"grok\"}\n");
    await writeUtf8File(path.join(grokHome, "config.toml"), "model = \"grok-code-fast-1\"\n");
    await writeUtf8File(path.join(grokHome, "mcp_credentials.json"), "{}\n");
    await writeUtf8File(path.join(grokHome, ".config-init.lock"), "lock");
    await ensureDirectory(path.join(grokHome, "bin"));
    await writeUtf8File(path.join(grokHome, "bin", "grok"), "binary");
    await ensureDirectory(path.join(grokHome, "sessions"));
    await writeUtf8File(path.join(grokHome, "sessions", "old.jsonl"), "session");
    await writeUtf8File(path.join(antigravityHome, "Preferences"), "{}\n");
    await ensureDirectory(path.join(antigravityHome, "bin"));
    await writeUtf8File(path.join(antigravityHome, "bin", "agy-node"), "binary");
    await writeUtf8File(path.join(antigravityCliHome, "antigravity-oauth-token"), "oauth-token");
    await ensureDirectory(path.join(antigravityCliHome, "cache"));
    await writeUtf8File(path.join(antigravityCliHome, "cache", "onboarding.json"), "{}\n");
    await ensureDirectory(path.join(antigravityCliHome, "conversations"));
    await writeUtf8File(path.join(antigravityCliHome, "conversations", "old.db"), "db");

    const homePath = "/var/lib/spawnfile/instances/pi/pi-app/home";
    const prepared = await preparePiRuntimeAuth({
      authProfile: await requireAuthProfile("dev"),
      env: {},
      instance: {
        config_path: "/var/lib/spawnfile/instances/pi/pi-app/pi/pi-app.json",
        home_path: homePath,
        id: "pi-app",
        model_auth_methods: {},
        model_secrets_required: [],
        runtime: "pi"
      },
      outputDirectory: "/tmp/out",
      tempRoot
    });

    expect(prepared.coveredModelSecrets).toEqual([]);
    expect(prepared.mountArgs[0]).toBe("-v");
    expect(prepared.mountArgs[2]).toBe("-v");
    expect(prepared.mountArgs[4]).toBe("-v");
    expect(prepared.mountArgs[1]).toMatch(new RegExp(`^${tempRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    expect(prepared.mountArgs[3]).toMatch(new RegExp(`^${tempRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    expect(prepared.mountArgs[5]).toMatch(new RegExp(`^${tempRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    expect(prepared.mountArgs.map((mount) => mount.replace(tempRoot, "<tmp>"))).toEqual([
      "-v",
      `<tmp>/runtime-auth/pi/grok-home:${homePath}/.grok`,
      "-v",
      `<tmp>/runtime-auth/pi/antigravity-home:${homePath}/.config/Antigravity`,
      "-v",
      `<tmp>/runtime-auth/pi/antigravity-cli-home:${homePath}/.gemini/antigravity-cli`
    ]);
    await expect(readUtf8File(path.join(tempRoot, "runtime-auth", "pi", "grok-home", "version.json"))).resolves.toContain("test");
    await expect(readUtf8File(path.join(tempRoot, "runtime-auth", "pi", "grok-home", "auth.json"))).resolves.toContain("grok");
    await expect(readUtf8File(path.join(tempRoot, "runtime-auth", "pi", "grok-home", "config.toml"))).resolves.toContain("grok-code-fast-1");
    await expect(readUtf8File(path.join(tempRoot, "runtime-auth", "pi", "grok-home", "mcp_credentials.json"))).resolves.toBe("{}\n");
    await expect(stat(path.join(tempRoot, "runtime-auth", "pi", "grok-home", "bin", "grok"))).rejects.toThrow();
    await expect(stat(path.join(tempRoot, "runtime-auth", "pi", "grok-home", "sessions", "old.jsonl"))).rejects.toThrow();
    await expect(stat(path.join(tempRoot, "runtime-auth", "pi", "grok-home", ".config-init.lock"))).rejects.toThrow();
    await expect(readUtf8File(path.join(tempRoot, "runtime-auth", "pi", "antigravity-home", "Preferences"))).resolves.toBe("{}\n");
    await expect(stat(path.join(tempRoot, "runtime-auth", "pi", "antigravity-home", "bin", "agy-node"))).rejects.toThrow();
    await expect(readUtf8File(path.join(tempRoot, "runtime-auth", "pi", "antigravity-cli-home", "antigravity-oauth-token"))).resolves.toBe("oauth-token");
    await expect(readUtf8File(path.join(tempRoot, "runtime-auth", "pi", "antigravity-cli-home", "cache", "onboarding.json"))).resolves.toBe("{}\n");
    await expect(stat(path.join(tempRoot, "runtime-auth", "pi", "antigravity-cli-home", "conversations", "old.db"))).rejects.toThrow();
  });

  it("skips auth preparation without a runtime home path", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-pi-auth-home-");
    const tempRoot = await createTempDirectory("spawnfile-pi-run-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    disableCliHomeDiscovery(tempRoot);
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
