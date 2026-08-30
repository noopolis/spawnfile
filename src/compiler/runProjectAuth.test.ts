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
  assertMoltnetCredentialValuesDistinct,
  prepareRuntimeAuthMounts,
  resolveAuthMountArgs,
  resolveRunEnvironment
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
  it("returns empty mounts when no auth profile is provided and the adapter needs no host credentials", async () => {
    await expect(
      prepareRuntimeAuthMounts("/tmp/out", createContainerReport("openclaw"), null, {}, "/tmp/run")
    ).resolves.toEqual({
      coveredModelSecrets: new Set(),
      mountArgs: []
    });
  });

  it("still stages a real-engine host CLI home (e.g. grok) for a pi instance when no auth profile is provided", async () => {
    // This is the composed real-engine regression case: `spawnfile up` (via
    // the simfile driver) never passes `--auth-profile`, since simfile's
    // charter forbids it from handling auth. The Pi adapter's optional
    // grok/codex/antigravity CLI-home staging (mirroring the e2e harness's
    // `stageGrokHome`) must not be gated behind an auth profile that has
    // nothing to do with those host credentials.
    const grokHome = await createTempDirectory("spawnfile-grok-home-");
    const tempRoot = await createTempDirectory("spawnfile-run-auth-");
    const previousGrokHome = process.env.GROK_HOME;
    process.env.GROK_HOME = grokHome;
    await writeUtf8File(path.join(grokHome, "auth.json"), "{\"token\":\"grok\"}\n");

    try {
      const prepared = await prepareRuntimeAuthMounts(
        "/tmp/out",
        createContainerReport("pi"),
        null,
        {},
        tempRoot
      );

      expect(prepared.coveredModelSecrets).toEqual(new Set());
      const grokMount = prepared.mountArgs.find((value) => value.endsWith("/.grok"));
      expect(grokMount).toBeDefined();
      expect(grokMount).toContain(`:${"/var/lib/spawnfile/instances/pi/instance/home"}/.grok`);
    } finally {
      if (previousGrokHome === undefined) {
        delete process.env.GROK_HOME;
      } else {
        process.env.GROK_HOME = previousGrokHome;
      }
    }
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

describe("resolveAuthMountArgs", () => {
  it("leaves the Pi runtime home to the Pi auth adapter", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    await registerImportedAuth("dev", "codex");
    const homePath = "/var/lib/spawnfile/instances/pi/instance/home";

    await expect(resolveAuthMountArgs({
      ...createContainerReport("pi"),
      runtime_homes: [homePath]
    }, await requireAuthProfile("dev"))).resolves.toEqual([]);
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

describe("assertMoltnetCredentialValuesDistinct", () => {
  const report = {
    ...createContainerReport("pi"),
    moltnet: {
      node_plans: [],
      server_plans: [{
        auth_mode: "bearer" as const,
        auth_tokens: [
          { agents: ["red"], id: "red", scopes: ["attach" as const, "write" as const], secret: "RED_TOKEN" },
          { agents: ["blue"], id: "blue", scopes: ["attach" as const, "write" as const], secret: "BLUE_TOKEN" },
          { agents: ["world"], id: "world", scopes: ["admin" as const, "observe" as const, "write" as const], secret: "WORLD_TOKEN" }
        ],
        base_url: "http://127.0.0.1:19971",
        id: "pitch",
        mode: "managed" as const,
        network_id: "pitch",
        rooms: []
      }]
    }
  };

  it("accepts three distinct bearer values", () => {
    expect(() => assertMoltnetCredentialValuesDistinct(report, {
      BLUE_TOKEN: "blue-secret",
      RED_TOKEN: "red-secret",
      WORLD_TOKEN: "world-secret"
    })).not.toThrow();
  });

  it("provisions missing managed bearer values without exposing a shared token", () => {
    const env = resolveRunEnvironment({
      ...report,
      secrets_required: ["BLUE_TOKEN", "RED_TOKEN", "WORLD_TOKEN"]
    }, null);
    expect(Object.keys(env).sort()).toEqual(["BLUE_TOKEN", "RED_TOKEN", "WORLD_TOKEN"]);
    expect(new Set(Object.values(env)).size).toBe(3);
    expect(Object.values(env).every((value) => value.length >= 32)).toBe(true);
  });

  it("rejects equal or whitespace-equivalent bearer values", () => {
    expect(() => assertMoltnetCredentialValuesDistinct(report, {
      BLUE_TOKEN: "shared",
      RED_TOKEN: "shared",
      WORLD_TOKEN: "world-secret"
    })).toThrow(/requires distinct credential values/);
    expect(() => assertMoltnetCredentialValuesDistinct(report, {
      BLUE_TOKEN: " blue-secret ",
      RED_TOKEN: "red-secret",
      WORLD_TOKEN: "world-secret"
    })).toThrow(/must not contain leading or trailing whitespace/);
  });
});
