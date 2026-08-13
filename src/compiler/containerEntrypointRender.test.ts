import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { renderEntrypoint } from "./containerEntrypointRender.js";
import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import type { MoltnetArtifacts } from "./moltnetArtifacts.js";

const serverPlan = (): MoltnetArtifacts["serverPlans"][number] =>
  ({
    baseUrl: "http://127.0.0.1:19187",
    configPath: "/var/lib/spawnfile/moltnet/servers/org-dist_lab/Moltnet.json",
    id: "org-dist_lab",
    mode: "managed",
    name: "Dist Lab",
    networkId: "dist_lab",
    port: 19187,
    rooms: [{ id: "room", members: ["coordinator"] }],
    secretPatches: [],
    server: {
      mode: "managed",
      store: { kind: "sqlite", path: "/x" }
    },
    teamSource: "/p/Spawnfile"
  }) as unknown as MoltnetArtifacts["serverPlans"][number];

const nodePlan = (): MoltnetArtifacts["nodePlans"][number] => ({
  configPath: "/var/lib/spawnfile/moltnet/nodes/dist_lab.json",
  networkId: "dist_lab"
});

const runtimePlan = (overrides: Partial<RuntimeTargetPlan> = {}): RuntimeTargetPlan => ({
  envFiles: [],
  id: "openclaw-target",
  instancePaths: {
    configPath: "/var/lib/spawnfile/openclaw/config.json",
    homePath: "/var/lib/spawnfile/openclaw/home",
    workspacePath: "/var/lib/spawnfile/openclaw/workspace"
  },
  meta: {
    configFileName: "config.json",
    instancePaths: {
      configPathTemplate: "<instance-root>/config.json",
      homePathTemplate: "<instance-root>/home",
      workspacePathTemplate: "<instance-root>/workspace"
    },
    standaloneBaseImage: "debian:bookworm-slim",
    startCommand: ["runtime"],
    systemDeps: []
  },
  modelAuthMethods: {},
  modelSecretsRequired: [],
  runtimeName: "openclaw",
  runtimeRoot: "/opt/runtime/openclaw",
  targetFiles: [],
  ...overrides
});

describe("renderEntrypoint network binding", () => {
  it("suppresses the in-image managed server when the network URL is bound", () => {
    const script = renderEntrypoint([], [], {
      hasMoltnet: true,
      moltnet: { externalParticipantArtifacts: [], nodePlans: [], serverPlans: [serverPlan()] }
    });
    expect(script).toContain('if [ -z "${SPAWNFILE_NETWORK_DIST_LAB_URL:-}" ]; then');
    // The server start and healthz wait live inside the guarded block.
    const guardIndex = script.indexOf("SPAWNFILE_NETWORK_DIST_LAB_URL");
    const serverIndex = script.indexOf("/usr/local/bin/moltnet &");
    expect(serverIndex).toBeGreaterThan(guardIndex);
    expect(script).toContain("/healthz");
  });

  it("installs declared external-participant DM topology before runtimes and nodes start", () => {
    const managed = {
      ...serverPlan(),
      server: {
        auth: {
          client: { token_id: "operator" },
          mode: "bearer",
          tokens: [{
            id: "operator",
            scopes: ["admin", "observe", "write"],
            secret: "MOLTNET_OPERATOR_TOKEN"
          }]
        },
        direct_messages: true,
        mode: "managed",
        store: { kind: "memory" }
      }
    } as unknown as MoltnetArtifacts["serverPlans"][number];
    const externalParticipant = {
      auth: {
        mode: "bearer",
        token_env: "MOLTNET_WORLD_TOKEN",
        token_id: "world"
      },
      direct_messages: [
        { members: ["blue", "world"] },
        { members: ["red", "world"] }
      ],
      network: { id: "dist_lab" },
      participant: {
        authored_key: "world",
        kind: "service",
        member_id: "world",
        principal_id: "system:world"
      },
      version: "spawnfile.moltnet-external-participant.v1"
    } as const;
    const script = renderEntrypoint([runtimePlan()], [], {
      hasMoltnet: true,
      moltnet: {
        externalParticipantArtifacts: [externalParticipant],
        nodePlans: [nodePlan()],
        serverPlans: [managed]
      }
    });

    const firstSeed = script.indexOf(
      "/usr/local/bin/moltnet admin dm ensure --sender 'world' --member 'blue' --member 'world'"
    );
    const secondSeed = script.indexOf(
      "/usr/local/bin/moltnet admin dm ensure --sender 'world' --member 'red' --member 'world'"
    );
    const runtimeStart = script.indexOf("'runtime' &");
    const nodeStart = script.indexOf("/usr/local/bin/moltnet node");
    expect(firstSeed).toBeGreaterThan(script.indexOf("/healthz"));
    expect(secondSeed).toBeGreaterThan(firstSeed);
    expect(runtimeStart).toBeGreaterThan(secondSeed);
    expect(nodeStart).toBeGreaterThan(runtimeStart);
    expect(script).toContain("--token-env 'MOLTNET_OPERATOR_TOKEN' >/dev/null");
  });

  it("rebinds bridge node base_url when the network URL is provided", () => {
    const script = renderEntrypoint([], [], {
      hasMoltnet: true,
      moltnet: { externalParticipantArtifacts: [], nodePlans: [nodePlan()], serverPlans: [] }
    });
    expect(script).toContain('if [ -n "${SPAWNFILE_NETWORK_DIST_LAB_URL:-}" ]; then');
    expect(script).toContain(
      "apply_json_env_value '/var/lib/spawnfile/moltnet/nodes/dist_lab.json' 'SPAWNFILE_NETWORK_DIST_LAB_URL' 'moltnet.base_url'"
    );
    expect(script).toContain(
      "/usr/local/bin/moltnet node '/var/lib/spawnfile/moltnet/nodes/dist_lab.json'"
    );
  });
});

describe("renderEntrypoint managed moltnet recipeEnv propagation", () => {
  it("prefixes NOOPOLIS_RUN_ID onto the managed moltnet server launch line, alongside the runtime exec line", () => {
    const script = renderEntrypoint(
      [runtimePlan({ recipeEnv: { NOOPOLIS_RUN_ID: "run-abc123" } })],
      [],
      {
        hasMoltnet: true,
        moltnet: { externalParticipantArtifacts: [], nodePlans: [], serverPlans: [serverPlan()] }
      }
    );

    expect(script).toContain(
      "MOLTNET_CONFIG='/var/lib/spawnfile/moltnet/servers/org-dist_lab/Moltnet.json' " +
        "MOLTNET_CAUSAL_EVENTS_PATH='/var/lib/spawnfile/moltnet/servers/org-dist_lab/causal/causal.jsonl' " +
        "NOOPOLIS_RUN_ID='run-abc123' /usr/local/bin/moltnet &"
    );
    // B93's per-target exec-time prefix must still carry the value too.
    expect(script).toContain("NOOPOLIS_RUN_ID='run-abc123'");
    expect(script.match(/NOOPOLIS_RUN_ID='run-abc123'/g)).toHaveLength(2);
  });

  it("prefixes NOOPOLIS_RUN_ID onto the managed moltnet node launch line", () => {
    const script = renderEntrypoint(
      [runtimePlan({ recipeEnv: { NOOPOLIS_RUN_ID: "run-abc123" } })],
      [],
      {
        hasMoltnet: true,
        moltnet: { externalParticipantArtifacts: [], nodePlans: [nodePlan()], serverPlans: [] }
      }
    );

    expect(script).toContain(
      "NOOPOLIS_RUN_ID='run-abc123' /usr/local/bin/moltnet node '/var/lib/spawnfile/moltnet/nodes/dist_lab.json' &"
    );
  });

  it("emits no extra assignment on the moltnet lines when recipeEnv is empty", () => {
    const script = renderEntrypoint(
      [runtimePlan({ recipeEnv: {} })],
      [],
      {
        hasMoltnet: true,
        moltnet: { externalParticipantArtifacts: [], nodePlans: [nodePlan()], serverPlans: [serverPlan()] }
      }
    );

    expect(script).not.toContain("NOOPOLIS_RUN_ID");
    expect(script).toContain(
      "MOLTNET_CONFIG='/var/lib/spawnfile/moltnet/servers/org-dist_lab/Moltnet.json' " +
        "MOLTNET_CAUSAL_EVENTS_PATH='/var/lib/spawnfile/moltnet/servers/org-dist_lab/causal/causal.jsonl' " +
        "/usr/local/bin/moltnet &"
    );
    expect(script).toContain(
      "/usr/local/bin/moltnet node '/var/lib/spawnfile/moltnet/nodes/dist_lab.json' &"
    );
  });

  it("emits no assignment on the moltnet lines when recipeEnv is undefined", () => {
    const script = renderEntrypoint([runtimePlan()], [], {
      hasMoltnet: true,
      moltnet: { externalParticipantArtifacts: [], nodePlans: [nodePlan()], serverPlans: [serverPlan()] }
    });

    expect(script).not.toContain("NOOPOLIS_RUN_ID");
  });
});

describe("renderEntrypoint managed moltnet causal events path", () => {
  it("always sets MOLTNET_CAUSAL_EVENTS_PATH as a sibling of the server's Moltnet.json, independent of store.kind", () => {
    // Gap 1b: a memory-store network (no persistent mount at all — see
    // office-sim's fixture) must still get a causal events path, since
    // capture reads it back with `docker cp` against the live container,
    // never through the store's own persistence.
    const memoryStorePlan = {
      ...serverPlan(),
      server: { mode: "managed", store: { kind: "memory" } }
    } as unknown as MoltnetArtifacts["serverPlans"][number];

    const script = renderEntrypoint([runtimePlan()], [], {
      hasMoltnet: true,
      moltnet: { externalParticipantArtifacts: [], nodePlans: [], serverPlans: [memoryStorePlan] }
    });

    expect(script).toContain(
      "MOLTNET_CAUSAL_EVENTS_PATH='/var/lib/spawnfile/moltnet/servers/org-dist_lab/causal/causal.jsonl'"
    );
  });

  it("carries NOOPOLIS_RUN_ID alongside MOLTNET_CAUSAL_EVENTS_PATH on the same launch line, so moltnet's causal writer and run id line up", () => {
    const script = renderEntrypoint(
      [runtimePlan({ recipeEnv: { NOOPOLIS_RUN_ID: "run-abc123" } })],
      [],
      {
        hasMoltnet: true,
        moltnet: { externalParticipantArtifacts: [], nodePlans: [], serverPlans: [serverPlan()] }
      }
    );

    const launchLine = script
      .split("\n")
      .find((line) => line.includes("/usr/local/bin/moltnet &"));
    expect(launchLine).toBeDefined();
    expect(launchLine).toContain("MOLTNET_CAUSAL_EVENTS_PATH=");
    expect(launchLine).toContain("NOOPOLIS_RUN_ID='run-abc123'");
  });
});

describe("renderEntrypoint MCP secret materialization", () => {
  const runBearerEntrypoint = (value: string | undefined) => {
    const root = mkdtempSync(join(tmpdir(), "spawnfile-b27-"));
    const configPath = join(root, "config.json");
    const markerPath = join(root, "started");
    writeFileSync(configPath, JSON.stringify({ headers: { Authorization: "" } }));

    const script = renderEntrypoint(
      [
        runtimePlan({
          configEnvBindings: [
            {
              envName: "MCP_TOKEN",
              jsonPath: "headers.Authorization",
              transform: "bearer"
            }
          ],
          instancePaths: {
            configPath,
            homePath: join(root, "home"),
            workspacePath: join(root, "workspace")
          },
          meta: {
            ...runtimePlan().meta,
            startCommand: ["touch", markerPath]
          }
        })
      ],
      ["MCP_TOKEN"]
    );
    const environment = { ...process.env };
    delete environment.MCP_TOKEN;
    if (value !== undefined) {
      environment.MCP_TOKEN = value;
    }
    const result = spawnSync("bash", ["-c", script], { env: environment });

    return {
      config: JSON.parse(readFileSync(configPath, "utf8")) as { headers: { Authorization: string } },
      markerExists: existsSync(markerPath),
      result,
      script
    };
  };

  it("applies Bearer exactly once at runtime", () => {
    const { config, markerExists, result, script } = runBearerEntrypoint("sample-token");

    expect(result.status).toBe(0);
    expect(markerExists).toBe(true);
    expect(config.headers.Authorization).toBe("Bearer sample-token");
    expect(config.headers.Authorization).not.toContain("Bearer Bearer");
    expect(script).not.toContain("sample-token");
  });

  it.each([undefined, ""])("fails before startup for %s required env values", (value) => {
    const { config, markerExists, result } = runBearerEntrypoint(value);

    expect(result.status).not.toBe(0);
    expect(markerExists).toBe(false);
    expect(config.headers.Authorization).toBe("");
  });

  it.each([
    {
      config: { mcp: { servers: { "a.b": { headers: { Authorization: "" } } } } },
      jsonPath: ["mcp", "servers", "a.b", "headers", "Authorization"],
      runtime: "OpenClaw"
    },
    {
      config: { tools: { mcp: { servers: { "a.b": { headers: { Authorization: "" } } } } } },
      jsonPath: ["tools", "mcp", "servers", "a.b", "headers", "Authorization"],
      runtime: "PicoClaw"
    }
  ])("materializes dotted MCP bearer paths for $runtime without creating sibling paths", ({ config, jsonPath }) => {
    const root = mkdtempSync(join(tmpdir(), "spawnfile-b27-dotted-"));
    const configPath = join(root, "config.json");
    const markerPath = join(root, "started");
    writeFileSync(configPath, JSON.stringify(config));
    const script = renderEntrypoint(
      [
        runtimePlan({
          configEnvBindings: [{ envName: "DOTTED_TOKEN", jsonPath, transform: "bearer" }],
          instancePaths: {
            configPath,
            homePath: join(root, "home"),
            workspacePath: join(root, "workspace")
          },
          meta: { ...runtimePlan().meta, startCommand: ["touch", markerPath] }
        })
      ],
      ["DOTTED_TOKEN"]
    );
    const result = spawnSync("bash", ["-c", script], {
      env: { ...process.env, DOTTED_TOKEN: "dotted-secret" }
    });
    const materialized = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, any>;
    const servers = materialized.mcp?.servers ?? materialized.tools?.mcp?.servers;

    expect(result.status).toBe(0);
    expect(existsSync(markerPath)).toBe(true);
    expect(servers["a.b"].headers.Authorization).toBe("Bearer dotted-secret");
    expect(servers.a).toBeUndefined();
  });
});

describe("renderEntrypoint CLI credential materialization", () => {
  it("requires CLI auth before materialization and startup, then unsets the runtime copy", () => {
    const root = mkdtempSync(join(tmpdir(), "spawnfile-cli-auth-"));
    const homePath = join(root, "home");
    const authPath = join(homePath, ".codex", "auth.json");
    const markerPath = join(root, "observed");
    const script = renderEntrypoint(
      [runtimePlan({
        meta: { ...runtimePlan().meta, startCommand: ["bash", "-c", `test -f ${authPath} && test -z "\${SPAWNFILE_CLI_AUTH_JSON:-}" && touch ${markerPath}`] },
        instancePaths: { configPath: join(root, "config.json"), homePath, workspacePath: join(root, "workspace") },
        modelAuthMethods: { openai: "codex" },
        runtimeName: "daimon"
      })],
      []
    );
    writeFileSync(join(root, "config.json"), "{}\n");

    const result = spawnSync("bash", ["-c", script], {
      env: { ...process.env, SPAWNFILE_CLI_AUTH_JSON: '{"tokens":{"access_token":"a"}}' }
    });

    expect(result.status).toBe(0);
    expect(existsSync(markerPath)).toBe(true);
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
    const guardIndex = script.indexOf("require_env 'SPAWNFILE_CLI_AUTH_JSON'");
    const materializationIndex = script.indexOf("printf %s \"${SPAWNFILE_CLI_AUTH_JSON}\"");
    const launchIndex = script.indexOf("exec 'bash' '-c'");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(materializationIndex);
    expect(guardIndex).toBeLessThan(launchIndex);
    expect(script).toContain(`CODEX_HOME='${homePath}/.codex'`);
    expect(script).toContain("unset SPAWNFILE_CLI_AUTH_JSON");
  });

  it("does not emit CLI auth guard or materialization when no runtime needs it", () => {
    const script = renderEntrypoint([runtimePlan()], []);

    expect(script).not.toContain("require_env 'SPAWNFILE_CLI_AUTH_JSON'");
    expect(script).not.toContain("SPAWNFILE_CLI_AUTH_JSON");
    expect(script).not.toContain("auth.json");
  });

  it("rejects a blank CLI credential through require_env", () => {
    const root = mkdtempSync(join(tmpdir(), "spawnfile-cli-auth-blank-"));
    const configPath = join(root, "config.json");
    writeFileSync(configPath, "{}\n");
    const script = renderEntrypoint(
      [runtimePlan({
        instancePaths: {
          configPath,
          homePath: join(root, "home"),
          workspacePath: join(root, "workspace")
        },
        meta: { ...runtimePlan().meta, startCommand: ["true"] },
        modelAuthMethods: { openai: "codex" }
      })],
      []
    );

    const result = spawnSync("bash", ["-c", script], {
      env: { ...process.env, SPAWNFILE_CLI_AUTH_JSON: "" }
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr.toString()).toContain("Missing required env: SPAWNFILE_CLI_AUTH_JSON");
  });
});
