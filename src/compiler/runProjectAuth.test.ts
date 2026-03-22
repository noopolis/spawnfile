import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  registerImportedAuth,
  requireAuthProfile,
  setAuthProfileEnv
} from "../auth/index.js";
import {
  ensureDirectory,
  removeDirectory,
  writeUtf8File
} from "../filesystem/index.js";
import type { ContainerReport } from "../report/index.js";

import {
  assertDeclaredModelAuthSatisfied,
  prepareRuntimeAuthMounts
} from "./runProjectAuth.js";

const previousSpawnfileHome = process.env.SPAWNFILE_HOME;
const temporaryDirectories: string[] = [];

const createTempDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

const createContainerReport = (runtime: string): ContainerReport => ({
  dockerfile: "Dockerfile",
  entrypoint: "entrypoint.sh",
  env_example: ".env.example",
  model_secrets_required: [],
  ports: [],
  runtime_instances: [
    {
      config_path: `/var/lib/spawnfile/instances/${runtime}/instance/config.json`,
      home_path: `/var/lib/spawnfile/instances/${runtime}/instance/home`,
      id: `${runtime}-instance`,
      model_auth_methods: {},
      model_secrets_required: [],
      runtime
    }
  ],
  runtime_homes: [],
  runtime_secrets_required: [],
  runtimes_installed: [runtime],
  secrets_required: []
});

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

afterEach(async () => {
  if (previousSpawnfileHome === undefined) {
    delete process.env.SPAWNFILE_HOME;
  } else {
    process.env.SPAWNFILE_HOME = previousSpawnfileHome;
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("prepareRuntimeAuthMounts", () => {
  it("returns empty mounts when no auth profile is provided", async () => {
    await expect(
      prepareRuntimeAuthMounts("/tmp/out", createContainerReport("openclaw"), null, {}, "/tmp/run")
    ).resolves.toEqual({
      coveredModelSecrets: new Set(),
      mountArgs: []
    });
  });

  it("skips runtimes that do not provide runtime-auth preparation hooks", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    const tempRoot = await createTempDirectory("spawnfile-run-auth-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    await setAuthProfileEnv("dev", {});

    await expect(
      prepareRuntimeAuthMounts(
        "/tmp/out",
        createContainerReport("tinyclaw"),
        await requireAuthProfile("dev"),
        {},
        tempRoot
      )
    ).resolves.toEqual({
      coveredModelSecrets: new Set(),
      mountArgs: []
    });
  });

  it("delegates runtime auth preparation to adapters with declared auth methods", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    const outputDirectory = await createTempDirectory("spawnfile-openclaw-out-");
    const tempRoot = await createTempDirectory("spawnfile-run-auth-");
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
      "/var/lib/spawnfile/instances/openclaw/instance/home/.openclaw/openclaw.json";
    await createContainerConfig(outputDirectory, configPath, {
      agents: {
        defaults: {
          model: "openai/gpt-5",
          workspace: "/workspace"
        }
      }
    });

    const prepared = await prepareRuntimeAuthMounts(
      outputDirectory,
      {
        ...createContainerReport("openclaw"),
        runtime_instances: [
          {
            config_path: configPath,
            home_path: "/var/lib/spawnfile/instances/openclaw/instance/home",
            id: "openclaw-instance",
            model_auth_methods: {
              openai: "codex"
            },
            model_secrets_required: [],
            runtime: "openclaw"
          }
        ]
      },
      await requireAuthProfile("dev"),
      {},
      tempRoot
    );

    expect(prepared.coveredModelSecrets).toEqual(new Set(["openclaw-instance:OPENAI_API_KEY"]));
    expect(prepared.mountArgs.length).toBeGreaterThan(0);
  });
});

describe("assertDeclaredModelAuthSatisfied", () => {
  it("allows API-key-only projects without an auth profile", () => {
    expect(() =>
      assertDeclaredModelAuthSatisfied(
        {
          ...createContainerReport("openclaw"),
          runtime_instances: [
            {
              config_path: "/var/lib/spawnfile/instances/openclaw/instance/config.json",
              home_path: "/var/lib/spawnfile/instances/openclaw/instance/home",
              id: "openclaw-instance",
              model_auth_methods: {
                anthropic: "api_key"
              },
              model_secrets_required: ["ANTHROPIC_API_KEY"],
              runtime: "openclaw"
            }
          ]
        },
        null
      )
    ).not.toThrow();
  });

  it("fails when declared imported auth methods have no selected profile", () => {
    expect(() =>
      assertDeclaredModelAuthSatisfied(
        {
          ...createContainerReport("openclaw"),
          runtime_instances: [
            {
              config_path: "/var/lib/spawnfile/instances/openclaw/instance/config.json",
              home_path: "/var/lib/spawnfile/instances/openclaw/instance/home",
              id: "openclaw-instance",
              model_auth_methods: {
                openai: "codex"
              },
              model_secrets_required: [],
              runtime: "openclaw"
            }
          ]
        },
        null
      )
    ).toThrow(/Auth profile is required/);
  });

  it("fails when the selected profile is missing a required auth import", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    const profile = await setAuthProfileEnv("dev", {});

    expect(() =>
      assertDeclaredModelAuthSatisfied(
        {
          ...createContainerReport("openclaw"),
          runtime_instances: [
            {
              config_path: "/var/lib/spawnfile/instances/openclaw/instance/config.json",
              home_path: "/var/lib/spawnfile/instances/openclaw/instance/home",
              id: "openclaw-instance",
              model_auth_methods: {
                anthropic: "claude-code"
              },
              model_secrets_required: [],
              runtime: "openclaw"
            }
          ]
        },
        profile
      )
    ).toThrow(/missing required auth imports: claude-code/);
  });
});
