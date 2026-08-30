import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CompilePlan, ResolvedAgentNode, ResolvedMemoryBank } from "./types.js";
import type { ContainerTargetInput } from "../runtime/index.js";
import * as runtimeIndex from "../runtime/index.js";
import { createContainerArtifacts } from "./containerArtifacts.js";
import { readTrustedMoltnetReleaseAuthority, trustedMoltnetReleaseAsset } from "./moltnetReleaseAuthority.js";
import { createRuntimeTargetPlans } from "./containerArtifactsPlans.js";
import { createExclusiveReattachVolumeName } from "../shared/index.js";
import { openClawAdapter } from "../runtime/openclaw/adapter.js";
import { picoClawAdapter } from "../runtime/picoclaw/adapter.js";
import { piAdapter } from "../runtime/pi/adapter.js";
import { createPiTestNode } from "../runtime/pi/testHelpers.js";

const createPlan = (runtimeNames: string[]): CompilePlan => ({
  edges: [],
  nodes: [],
  root: "/tmp/Spawnfile",
  runtimes: Object.fromEntries(runtimeNames.map((runtimeName) => [runtimeName, { nodeIds: [] }]))
});

const createAgentNode = (
  runtimeName: "openclaw" | "picoclaw",
  overrides: Partial<ResolvedAgentNode> = {}
): ResolvedAgentNode => ({
  description: "",
  docs: [],
  env: {},
  execution: undefined,
  kind: "agent",
  mcpServers: [],
  name: "assistant",
  policyMode: null,
  policyOnDegrade: null,
  runtime: { name: runtimeName, options: {} },
  secrets: [],
  skills: [],
  source: `/tmp/${runtimeName}/Spawnfile`,
  subagents: [],
  ...overrides
});

const createMemoryBank = (
  source: string,
  store: ResolvedMemoryBank["store"]
): ResolvedMemoryBank => ({
  consolidation: { mode: "disabled" },
  declaredBy: "agent",
  declaredName: "assistant",
  id: "shared-memory",
  index: {
    graph: { enabled: false },
    lexical: { enabled: true },
    rerank: { enabled: false },
    vector: { enabled: false }
  },
  retention: { forgetting: "manual" },
  source,
  store
} as const);

describe("createContainerArtifacts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders runtime-required env vars when the adapter declares them", async () => {
    const node = createAgentNode("openclaw");
    const compiled = await openClawAdapter.compileAgent(node);

    const result = await createContainerArtifacts(createPlan(["openclaw"]), [
      {
        emittedFiles: compiled.files,
        kind: "agent",
        runtimeName: "openclaw",
        slug: "assistant",
        value: node
      }
    ]);

    expect(result.report.secrets_required).toEqual(["OPENCLAW_GATEWAY_TOKEN"]);
    expect(result.report.model_secrets_required).toEqual([]);
    expect(result.files.find((file) => file.path === ".dockerignore")).toEqual({
      content: "runtimes/\nspawnfile-report.json\ndeployments/\n",
      path: ".dockerignore"
    });
    expect(result.files.find((file) => file.path === ".env.example")?.content).toContain(
      "OPENCLAW_GATEWAY_TOKEN="
    );
  });

  it("emits bearer MCP placeholders, required env names, and isolated target bindings", async () => {
    const first = createAgentNode("openclaw", {
      mcpServers: [
        {
          auth: { mode: "bearer", secret: "FIRST_MCP_TOKEN" },
          name: "first-search",
          transport: "streamable_http",
          url: "https://first.example/mcp"
        }
      ],
      name: "first",
      source: "/tmp/openclaw/first/Spawnfile"
    });
    const second = createAgentNode("openclaw", {
      mcpServers: [
        {
          auth: { secret: "SECOND_MCP_TOKEN" },
          name: "second-search",
          transport: "sse",
          url: "https://second.example/mcp"
        }
      ],
      name: "second",
      source: "/tmp/openclaw/second/Spawnfile"
    });
    const compiledFirst = await openClawAdapter.compileAgent(first);
    const compiledSecond = await openClawAdapter.compileAgent(second);
    const result = await createContainerArtifacts(createPlan(["openclaw"]), [
      {
        emittedFiles: compiledFirst.files,
        id: "agent:first",
        kind: "agent",
        runtimeName: "openclaw",
        slug: "first",
        value: first
      },
      {
        emittedFiles: compiledSecond.files,
        id: "agent:second",
        kind: "agent",
        runtimeName: "openclaw",
        slug: "second",
        value: second
      }
    ]);

    const firstConfigFile = result.files.find((file) =>
      file.path.endsWith("/agent-first/home/.openclaw/openclaw.json")
    );
    const secondConfigFile = result.files.find((file) =>
      file.path.endsWith("/agent-second/home/.openclaw/openclaw.json")
    );
    const entrypoint = result.files.find((file) => file.path === "entrypoint.sh")?.content ?? "";
    const envExample = result.files.find((file) => file.path === ".env.example")?.content ?? "";
    const distributionReport = result.files.find((file) => file.path === "distribution-report.json")?.content ?? "";
    const firstConfig = JSON.parse(firstConfigFile!.content);
    const secondConfig = JSON.parse(secondConfigFile!.content);
    const firstBindingLine = entrypoint
      .split("\n")
      .find((line) => line.includes("agent-first/home/.openclaw/openclaw.json") && line.includes("apply_json_env_value"));
    const secondBindingLine = entrypoint
      .split("\n")
      .find((line) => line.includes("agent-second/home/.openclaw/openclaw.json") && line.includes("apply_json_env_value"));

    expect(firstConfig.mcp.servers["first-search"].headers).toEqual({ Authorization: "" });
    expect(secondConfig.mcp.servers["second-search"].headers).toEqual({ SECOND_MCP_TOKEN: "" });
    expect(result.report.secrets_required).toEqual([
      "FIRST_MCP_TOKEN",
      "OPENCLAW_GATEWAY_TOKEN",
      "SECOND_MCP_TOKEN"
    ]);
    expect(result.report.runtime_secrets_required).toContain("FIRST_MCP_TOKEN");
    expect(envExample).toContain("FIRST_MCP_TOKEN=");
    expect(envExample).toContain("SECOND_MCP_TOKEN=");
    expect(distributionReport).toContain("FIRST_MCP_TOKEN");
    expect(distributionReport).toContain("SECOND_MCP_TOKEN");
    expect([firstConfigFile!.content, secondConfigFile!.content, entrypoint, envExample, distributionReport].join("\n"))
      .not.toContain("sample-resolved-token");
    expect(firstBindingLine).toContain("FIRST_MCP_TOKEN");
    expect(firstBindingLine).not.toContain("SECOND_MCP_TOKEN");
    expect(firstBindingLine).toContain("'bearer'");
    expect(secondBindingLine).toContain("SECOND_MCP_TOKEN");
    expect(secondBindingLine).not.toContain("FIRST_MCP_TOKEN");
    expect(secondBindingLine).not.toContain("'bearer'");
  });

  it("isolates PicoClaw MCP secrets and auth modes across targets", async () => {
    const first = createAgentNode("picoclaw", {
      mcpServers: [
        {
          auth: { mode: "bearer", secret: "PICO_FIRST_TOKEN" },
          name: "shared.mcp",
          transport: "streamable_http",
          url: "https://first.example/mcp"
        }
      ],
      name: "first",
      source: "/tmp/picoclaw/first/Spawnfile"
    });
    const second = createAgentNode("picoclaw", {
      mcpServers: [
        {
          auth: { secret: "PICO_SECOND_TOKEN" },
          name: "shared.mcp",
          transport: "sse",
          url: "https://second.example/mcp"
        }
      ],
      name: "second",
      source: "/tmp/picoclaw/second/Spawnfile"
    });
    const compiledFirst = await picoClawAdapter.compileAgent(first);
    const compiledSecond = await picoClawAdapter.compileAgent(second);
    const result = await createContainerArtifacts(createPlan(["picoclaw"]), [
      {
        emittedFiles: compiledFirst.files,
        id: "agent:first",
        kind: "agent",
        runtimeName: "picoclaw",
        slug: "first",
        value: first
      },
      {
        emittedFiles: compiledSecond.files,
        id: "agent:second",
        kind: "agent",
        runtimeName: "picoclaw",
        slug: "second",
        value: second
      }
    ]);
    const entrypoint = result.files.find((file) => file.path === "entrypoint.sh")?.content ?? "";
    const firstBinding = entrypoint
      .split("\n")
      .find((line) => line.includes("agent-first") && line.includes("apply_json_env_value"));
    const secondBinding = entrypoint
      .split("\n")
      .find((line) => line.includes("agent-second") && line.includes("apply_json_env_value"));
    const firstConfig = JSON.parse(
      result.files.find((file) => file.path.endsWith("/agent-first/picoclaw/config.json"))!.content
    );
    const secondConfig = JSON.parse(
      result.files.find((file) => file.path.endsWith("/agent-second/picoclaw/config.json"))!.content
    );

    expect(firstConfig.tools.mcp.servers["shared.mcp"].headers).toEqual({ Authorization: "" });
    expect(secondConfig.tools.mcp.servers["shared.mcp"].headers).toEqual({ PICO_SECOND_TOKEN: "" });
    expect(firstBinding).toContain("PICO_FIRST_TOKEN");
    expect(firstBinding).not.toContain("PICO_SECOND_TOKEN");
    expect(firstBinding).toContain("'bearer'");
    expect(secondBinding).toContain("PICO_SECOND_TOKEN");
    expect(secondBinding).not.toContain("PICO_FIRST_TOKEN");
    expect(secondBinding).not.toContain("'bearer'");
  });

  it("renders Discord surface secrets when an agent declares Discord", async () => {
    const node = createAgentNode("openclaw", {
      surfaces: {
        discord: {
          botTokenSecret: "DISCORD_BOT_TOKEN"
        }
      }
    });
    const compiled = await openClawAdapter.compileAgent(node);

    const result = await createContainerArtifacts(createPlan(["openclaw"]), [
      {
        emittedFiles: compiled.files,
        kind: "agent",
        runtimeName: "openclaw",
        slug: "assistant",
        value: node
      }
    ]);

    expect(result.report.secrets_required).toEqual([
      "DISCORD_BOT_TOKEN",
      "OPENCLAW_GATEWAY_TOKEN"
    ]);
    expect(result.files.find((file) => file.path === ".env.example")?.content).toContain(
      "DISCORD_BOT_TOKEN="
    );
  });

  it("renders Telegram surface secrets when an agent declares Telegram", async () => {
    const node = createAgentNode("openclaw", {
      surfaces: {
        telegram: {
          botTokenSecret: "TELEGRAM_BOT_TOKEN"
        }
      }
    });
    const compiled = await openClawAdapter.compileAgent(node);

    const result = await createContainerArtifacts(createPlan(["openclaw"]), [
      {
        emittedFiles: compiled.files,
        kind: "agent",
        runtimeName: "openclaw",
        slug: "assistant",
        value: node
      }
    ]);

    expect(result.report.secrets_required).toEqual([
      "OPENCLAW_GATEWAY_TOKEN",
      "TELEGRAM_BOT_TOKEN"
    ]);
    expect(result.files.find((file) => file.path === ".env.example")?.content).toContain(
      "TELEGRAM_BOT_TOKEN="
    );
  });

  it("renders OpenClaw Moltnet token secrets from runtime options", async () => {
    const node = createAgentNode("openclaw", {
      runtime: {
        name: "openclaw",
        options: {
          moltnet: {
            base_url: "http://127.0.0.1:8787",
            token_secret: "MOLTNET_API_TOKEN"
          }
        }
      }
    });
    const compiled = await openClawAdapter.compileAgent(node);

    const result = await createContainerArtifacts(createPlan(["openclaw"]), [
      {
        emittedFiles: compiled.files,
        kind: "agent",
        runtimeName: "openclaw",
        slug: "assistant",
        value: node
      }
    ]);

    expect(result.report.secrets_required).toEqual([
      "MOLTNET_API_TOKEN",
      "OPENCLAW_GATEWAY_TOKEN"
    ]);
    expect(result.files.find((file) => file.path === ".env.example")?.content).toContain(
      "MOLTNET_API_TOKEN="
    );
  });

  it("renders generated OpenClaw hooks env for moltnet-attached agents", async () => {
    const node = createAgentNode("openclaw", {
      surfaces: {
        moltnet: [
          {
            memberId: "assistant",
            network: "local_lab",
            rooms: { research: {} },
            teamSource: "/tmp/team/Spawnfile"
          }
        ]
      }
    });
    const compiled = await openClawAdapter.compileAgent(node);

    const result = await createContainerArtifacts(createPlan(["openclaw"]), [
      {
        emittedFiles: compiled.files,
        kind: "agent",
        runtimeName: "openclaw",
        slug: "assistant",
        value: node
      }
    ]);
    const entrypoint = result.files.find((file) => file.path === "entrypoint.sh")?.content ?? "";

    expect(result.report.runtime_secrets_required).toEqual([
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_HOOKS_TOKEN"
    ]);
    expect(result.files.find((file) => file.path === ".env.example")?.content).toContain(
      "OPENCLAW_HOOKS_TOKEN="
    );
    expect(entrypoint.indexOf('export OPENCLAW_HOOKS_TOKEN="hooks-${OPENCLAW_GATEWAY_TOKEN}"')).toBeLessThan(
      entrypoint.indexOf("require_env 'OPENCLAW_HOOKS_TOKEN'")
    );
  });

  it("reports Moltnet persistent mounts from generated artifacts", async () => {
    const moltnetNode = createAgentNode("picoclaw");
    const moltnetCompiled = { capabilities: [], diagnostics: [], files: [] };
    void moltnetCompiled;
    const result = await createContainerArtifacts(createPlan(["picoclaw"]), [
      {
        emittedFiles: [],
        kind: "agent",
        runtimeName: "picoclaw",
        slug: "assistant",
        value: moltnetNode
      }
    ], {
      hasStagedMoltnetBinaries: true,
      moltnet: {
        files: [],
        nodePlans: [],
        persistentMounts: [
          {
            id: "moltnet-local-lab-store",
            mountPath: "/var/lib/spawnfile/moltnet/networks/local-lab",
            reason: "managed Moltnet sqlite store for local-lab",
            volumeName: "spawnfile-local-lab-state"
          }
        ],
        ports: [],
        publishedPorts: [],
        serverPlans: []
      }
    });
    const dockerfile = result.files.find((file) => file.path === "Dockerfile")?.content ?? "";

    expect(result.report.persistent_mounts).toEqual([
      {
        id: "moltnet-local-lab-store",
        mount_path: "/var/lib/spawnfile/moltnet/networks/local-lab",
        reason: "managed Moltnet sqlite store for local-lab",
        volume_name: "spawnfile-local-lab-state"
      }
    ]);
    expect(dockerfile).toContain(
      "mkdir -p '/var/lib/spawnfile' '/var/lib/spawnfile/moltnet/networks/local-lab'"
    );
    expect(dockerfile).toContain(
      "spawnfile.volume-bootstrap.v1"
    );
  });

  it("includes durable sqlite stores as container memory artifacts", async () => {
    const node = createAgentNode("openclaw", { source: "/tmp/openclaw/memory" });
    const compiled = await openClawAdapter.compileAgent(node);
    const memoryPlan: CompilePlan = {
      ...createPlan(["openclaw"]),
      nodes: [
        {
          id: "agent:assistant",
          kind: "agent",
          runtimeName: "openclaw",
          slug: "assistant",
          value: node
        }
      ],
      memoryAccess: [
        {
          agentSource: "/tmp/openclaw/memory",
          declaringKind: "agent",
          source: "/tmp/openclaw/memory",
          bank: createMemoryBank("/tmp/openclaw/memory", {
            kind: "sqlite",
            path: "/var/lib/spawnfile/memory/assistant/shared-memory/memory.sqlite",
            persistence: { mode: "durable" }
          })
        }
      ]
    };
    const result = await createContainerArtifacts(memoryPlan, [
      {
        emittedFiles: compiled.files,
        kind: "agent",
        runtimeName: "openclaw",
        slug: "assistant",
        value: node
      }
    ]);
    const dockerfile = result.files.find((file) => file.path === "Dockerfile")?.content ?? "";
    // Durable memory volumes are deployment-lineage scoped, never run scoped:
    // a run-scoped name gave every redeploy a fresh empty bank. This compile
    // passes no deploymentLineage, so it lands on the "compile" lineage.
    const expectedVolumeName = createExclusiveReattachVolumeName(
      "/tmp/Spawnfile\u0000compile",
      "memory-var-lib-spawnfile-memory-assistant-shared-memory"
    );

    expect(result.report.memory).toEqual([
      {
        accessible_node_ids: ["agent:assistant"],
        declaring_node_id: "agent:assistant",
        id: "shared-memory",
        store: {
          kind: "sqlite",
          path: "/var/lib/spawnfile/memory/assistant/shared-memory/memory.sqlite",
          persistence: "durable",
          persistent_mount_id: "memory-var-lib-spawnfile-memory-assistant-shared-memory"
        },
        transport_by_node_id: {
          "agent:assistant": "mcp"
        },
        index: {
          graph: { enabled: false },
          lexical: { enabled: true },
          rerank: { enabled: false },
          vector: { enabled: false }
        },
        consolidation: { mode: "disabled" },
        retention: { forgetting: "manual" }
      }
    ]);
    // The lifecycle must reach the distribution report too: the sourceless
    // consume-image path derives its own volume name from these fields, and
    // only the exclusive lifecycle gets the host-stable reattachable name.
    expect(result.distribution.report.persistent_mounts).toEqual([
      {
        durability: "persistent",
        id: "memory-var-lib-spawnfile-memory-assistant-shared-memory",
        kind: "volume",
        lifecycle: "exclusive-reattach",
        target: "/var/lib/spawnfile/memory/assistant/shared-memory"
      }
    ]);
    expect(result.report.persistent_mounts).toEqual([
      {
        id: "memory-var-lib-spawnfile-memory-assistant-shared-memory",
        lifecycle: "exclusive-reattach",
        mount_path: "/var/lib/spawnfile/memory/assistant/shared-memory",
        reason: "durable memory stores under /var/lib/spawnfile/memory/assistant/shared-memory",
        volume_name: expectedVolumeName
      }
    ]);
    expect(dockerfile).toContain(
      "mkdir -p '/var/lib/spawnfile' '/var/lib/spawnfile/memory/assistant/shared-memory'"
    );
    expect(dockerfile).toContain(
      "spawnfile.volume-bootstrap.v1"
    );
  });

  it("omits ephemeral sqlite/postgres/memory stores from persistent mounts", async () => {
    const node = createAgentNode("openclaw", { source: "/tmp/openclaw/ephemeral-memory" });
    const compiled = await openClawAdapter.compileAgent(node);
    const memoryPlan: CompilePlan = {
      ...createPlan(["openclaw"]),
      nodes: [
        {
          id: "agent:assistant",
          kind: "agent",
          runtimeName: "openclaw",
          slug: "assistant",
          value: node
        }
      ],
      memoryAccess: [
        {
          agentSource: "/tmp/openclaw/ephemeral-memory",
          declaringKind: "agent",
          source: "/tmp/openclaw/ephemeral-memory",
          bank: {
            ...createMemoryBank("/tmp/openclaw/ephemeral-memory", {
              kind: "sqlite",
              path: "/tmp/assistant/ephemeral.sqlite",
              persistence: { mode: "ephemeral" }
            }),
            id: "ephemeral-sqlite"
          }
        },
        {
          agentSource: "/tmp/openclaw/ephemeral-memory",
          declaringKind: "agent",
          source: "/tmp/openclaw/ephemeral-memory",
          bank: {
            ...createMemoryBank("/tmp/openclaw/ephemeral-memory", {
              kind: "memory"
            }),
            id: "memory-only"
          }
        },
        {
          agentSource: "/tmp/openclaw/ephemeral-memory",
          declaringKind: "agent",
          source: "/tmp/openclaw/ephemeral-memory",
          bank: {
            ...createMemoryBank("/tmp/openclaw/ephemeral-memory", {
              kind: "postgres",
              dsn_secret: "POSTGRES_DSN"
            }),
            id: "remote-postgres"
          }
        }
      ]
    };
    const result = await createContainerArtifacts(memoryPlan, [
      {
        emittedFiles: compiled.files,
        kind: "agent",
        runtimeName: "openclaw",
        slug: "assistant",
        value: node
      }
    ]);

    expect(result.distribution.report.persistent_mounts).toEqual([]);
    expect(result.report.persistent_mounts).toBeUndefined();
    expect(result.report.memory?.map((memory) => memory.store.kind).sort()).toEqual([
      "memory",
      "postgres",
      "sqlite"
    ]);
  });

  it("renders workspace resource startup and report metadata", async () => {
    const node = createAgentNode("openclaw", {
      workspaceResources: [
        {
          branch: "main",
          id: "project",
          kind: "git",
          mode: "mutable",
          mount: "./repos/project",
          scope: {
            kind: "agent",
            key: "/tmp/openclaw/Spawnfile",
            name: "assistant"
          },
          sharing: "per_agent",
          url: "https://example.com/project.git"
        },
        {
          id: "cache",
          kind: "volume",
          mode: "readonly",
          mount: "./cache",
          scope: {
            kind: "agent",
            key: "/tmp/openclaw/Spawnfile",
            name: "assistant"
          },
          sharing: "per_agent"
        }
      ]
    });
    const compiled = await openClawAdapter.compileAgent(node);

    const result = await createContainerArtifacts(createPlan(["openclaw"]), [
      {
        emittedFiles: compiled.files,
        kind: "agent",
        runtimeName: "openclaw",
        slug: "assistant",
        value: node
      }
    ]);
    const dockerfile = result.files.find((file) => file.path === "Dockerfile")?.content ?? "";
    const entrypoint = result.files.find((file) => file.path === "entrypoint.sh")?.content ?? "";

    expect(dockerfile).toContain(" git ");
    expect(entrypoint).toContain(
      "prepare_volume_resource 'cache' '/var/lib/spawnfile/instances/openclaw/agent-assistant/home/.openclaw/workspace/cache' '/var/lib/spawnfile/resources/instances/agent-assistant-"
    );
    expect(entrypoint).toContain(
      "prepare_git_resource 'project' '/var/lib/spawnfile/instances/openclaw/agent-assistant/home/.openclaw/workspace/repos/project' '/var/lib/spawnfile/resources/instances/agent-assistant-"
    );
    expect(result.report.workspace_resources).toEqual([
      {
        backing_path: expect.stringContaining("/var/lib/spawnfile/resources/instances/agent-assistant-"),
        id: "cache",
        kind: "volume",
        link_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home/.openclaw/workspace/cache",
        mode: "readonly",
        mount: "./cache",
        mount_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home/.openclaw/workspace/cache",
        replacement_sentinel: { path: expect.stringContaining("/.spawnfile-resource-identity"), result: "verified_on_startup" },
        resolved_identity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        sharing: "per_agent",
        volume_name: expect.stringMatching(/^spawnfile-workspace-resource-[a-f0-9]{24}$/u)
      },
      {
        backing_path: expect.stringContaining("/var/lib/spawnfile/resources/instances/agent-assistant-"),
        id: "project",
        kind: "git",
        link_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home/.openclaw/workspace/repos/project",
        mode: "mutable",
        mount: "./repos/project",
        mount_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home/.openclaw/workspace/repos/project",
        replacement_sentinel: undefined,
        resolved_identity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        sharing: "per_agent",
        volume_name: null
      }
    ]);
  });

  it("derives provider env vars and promotes duplicate secrets to required", async () => {
    const firstNode = createAgentNode("openclaw", {
      execution: {
        model: {
          primary: {
            name: "custom-model",
            provider: "proxy-api"
          }
        }
      },
      expose: true,
      secrets: [{ name: "SHARED_TOKEN", required: false }]
    });
    const secondNode = createAgentNode("openclaw", {
      expose: true,
      name: "writer",
      secrets: [{ name: "SHARED_TOKEN", required: true }]
    });

    const firstCompiled = await openClawAdapter.compileAgent(firstNode);
    const secondCompiled = await openClawAdapter.compileAgent(secondNode);
    const result = await createContainerArtifacts(createPlan(["openclaw"]), [
      {
        emittedFiles: firstCompiled.files,
        kind: "agent",
        runtimeName: "openclaw",
        slug: "assistant",
        value: firstNode
      },
      {
        emittedFiles: secondCompiled.files,
        kind: "agent",
        runtimeName: "openclaw",
        slug: "writer",
        value: secondNode
      }
    ]);

    expect(result.report.secrets_required).toEqual([
      "OPENCLAW_GATEWAY_TOKEN",
      "PROXY_API_API_KEY",
      "SHARED_TOKEN"
    ]);
    expect(result.report.model_secrets_required).toEqual(["PROXY_API_API_KEY"]);
    expect(result.report.ports).toEqual([18789, 18809]);
    expect(result.report.internal_ports).toEqual([18789, 18809]);
    expect(result.report.published_ports).toEqual([18789, 18809]);
    expect(result.report.port_mappings).toEqual([
      { internal_port: 18789, published_port: 18789 },
      { internal_port: 18809, published_port: 18809 }
    ]);
    expect(result.report.runtime_instances).toEqual([
      {
        config_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home/.openclaw/openclaw.json",
        home_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home",
        id: "agent-assistant",
        internal_port: 18789,
        model_auth_methods: {
          "proxy-api": "api_key"
        },
        model_secrets_required: ["PROXY_API_API_KEY"],
        node_ids: ["agent:assistant"],
        published_port: 18789,
        runtime: "openclaw",
        workspace_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home/.openclaw/workspace"
      },
      {
        config_path: "/var/lib/spawnfile/instances/openclaw/agent-writer/home/.openclaw/openclaw.json",
        home_path: "/var/lib/spawnfile/instances/openclaw/agent-writer/home",
        id: "agent-writer",
        internal_port: 18809,
        model_auth_methods: {},
        model_secrets_required: [],
        node_ids: ["agent:writer"],
        published_port: 18809,
        runtime: "openclaw",
        workspace_path: "/var/lib/spawnfile/instances/openclaw/agent-writer/home/.openclaw/workspace"
      }
    ]);
    expect(result.report.runtime_homes).toEqual([
      "/var/lib/spawnfile/instances/openclaw/agent-assistant/home",
      "/var/lib/spawnfile/instances/openclaw/agent-writer/home"
    ]);
    expect(result.report.runtime_secrets_required).toEqual(["OPENCLAW_GATEWAY_TOKEN"]);

    const envExample = result.files.find((file) => file.path === ".env.example")?.content ?? "";
    expect(envExample).toContain("OPENCLAW_GATEWAY_TOKEN=");
    expect(envExample).toContain("PROXY_API_API_KEY=");
    expect(envExample).toContain("SHARED_TOKEN=");
  });

  it("rejects conflicting package versions across separate targets in one image", async () => {
    const firstNode = createAgentNode("openclaw", {
      packages: [
        {
          id: "curl",
          manager: "apt",
          name: "curl",
          version: "8.8"
        }
      ]
    });
    const secondNode = createAgentNode("openclaw", {
      name: "writer",
      packages: [
        {
          id: "curl",
          manager: "apt",
          name: "curl",
          version: "8.9"
        }
      ],
      source: "/tmp/openclaw/writer/Spawnfile"
    });

    const firstCompiled = await openClawAdapter.compileAgent(firstNode);
    const secondCompiled = await openClawAdapter.compileAgent(secondNode);

    await expect(
      createContainerArtifacts(createPlan(["openclaw"]), [
        {
          emittedFiles: firstCompiled.files,
          kind: "agent",
          runtimeName: "openclaw",
          slug: "assistant",
          value: firstNode
        },
        {
          emittedFiles: secondCompiled.files,
          kind: "agent",
          runtimeName: "openclaw",
          slug: "writer",
          value: secondNode
        }
      ])
    ).rejects.toThrow("conflicting package definitions for apt package curl");
  });

  it("builds PicoClaw from the pinned release archive", async () => {
    const node = createAgentNode("picoclaw", {
      execution: {
        model: {
          primary: {
            name: "gpt-5.4",
            provider: "openai"
          }
        }
      }
    });
    const compiled = await picoClawAdapter.compileAgent(node);

    const result = await createContainerArtifacts(createPlan(["picoclaw"]), [
      {
        emittedFiles: compiled.files,
        kind: "agent",
        runtimeName: "picoclaw",
        slug: "assistant",
        value: node
      }
    ]);

    const dockerfile = result.files.find((file) => file.path === "Dockerfile")?.content ?? "";
    const entrypoint = result.files.find((file) => file.path === "entrypoint.sh")?.content ?? "";
    const configFile = result.files.find(
      (file) =>
        file.path ===
        "container/rootfs/var/lib/spawnfile/instances/picoclaw/agent-assistant/picoclaw/config.json"
    );

    expect(dockerfile).toContain("FROM debian:bookworm-slim");
    expect(dockerfile).toContain(
      "COPY --from=noopolis/spawnfile-runtime-picoclaw:0.3.1 /opt/spawnfile/runtime-installs/picoclaw /opt/spawnfile/runtime-installs/picoclaw"
    );
    expect(dockerfile).toContain(
      "RUN mkdir -p /usr/local/bin && ln -sf /opt/spawnfile/runtime-installs/picoclaw/bin/picoclaw /usr/local/bin/picoclaw"
    );
    expect(dockerfile).not.toContain("runtime-sources");
    expect(dockerfile).not.toContain("go build -o /usr/local/bin/picoclaw");
    expect(dockerfile).toContain("COPY container/rootfs/ /");
    expect(dockerfile).not.toContain("COPY . /opt/spawnfile");
    expect(entrypoint).toContain("PICOCLAW_HOME=");
    expect(entrypoint).toContain("PICOCLAW_GATEWAY_HOST='0.0.0.0'");
    expect(entrypoint).toContain(
      "write_env_file 'OPENAI_API_KEY' '/var/lib/spawnfile/instances/picoclaw/agent-assistant/picoclaw/secrets/OPENAI_API_KEY'"
    );
    expect(entrypoint).not.toContain("prepare_target");
    expect(configFile?.content).toContain(
      "/var/lib/spawnfile/instances/picoclaw/agent-assistant/picoclaw/workspace"
    );
    expect(configFile?.content).toContain("file://secrets/OPENAI_API_KEY");
  });

  it("configures PicoClaw Codex auth through the Codex CLI provider", async () => {
    const node = createAgentNode("picoclaw", {
      execution: {
        model: {
          primary: {
            auth: { method: "codex" },
            name: "gpt-5.5",
            provider: "openai"
          }
        }
      }
    });
    const compiled = await picoClawAdapter.compileAgent(node);

    const result = await createContainerArtifacts(createPlan(["picoclaw"]), [
      {
        emittedFiles: compiled.files,
        kind: "agent",
        runtimeName: "picoclaw",
        slug: "assistant",
        value: node
      }
    ]);

    const entrypoint = result.files.find((file) => file.path === "entrypoint.sh")?.content ?? "";
    const configFile = result.files.find(
      (file) =>
        file.path ===
        "container/rootfs/var/lib/spawnfile/instances/picoclaw/agent-assistant/picoclaw/config.json"
    );

    expect(result.report.model_secrets_required).toEqual(["SPAWNFILE_CLI_AUTH_JSON"]);
    expect(result.report.runtime_instances).toEqual([
      {
        config_path: "/var/lib/spawnfile/instances/picoclaw/agent-assistant/picoclaw/config.json",
        home_path: "/var/lib/spawnfile/instances/picoclaw/agent-assistant/picoclaw",
        id: "agent-assistant",
        internal_port: 18990,
        model_auth_methods: {
          openai: "codex"
        },
        model_secrets_required: ["SPAWNFILE_CLI_AUTH_JSON"],
        node_ids: ["agent:assistant"],
        published_port: null,
        runtime: "picoclaw",
        workspace_path: "/var/lib/spawnfile/instances/picoclaw/agent-assistant/picoclaw/workspace"
      }
    ]);
    expect(configFile?.content).toContain("\"model\": \"codex-cli/gpt-5.5\"");
    expect(configFile?.content).toContain(
      "\"workspace\": \"/var/lib/spawnfile/instances/picoclaw/agent-assistant/picoclaw/workspace\""
    );
    expect(configFile?.content).not.toContain("file://secrets/OPENAI_API_KEY");
    expect(entrypoint).toContain(
      "CODEX_HOME='/var/lib/spawnfile/instances/picoclaw/agent-assistant/picoclaw/.codex'"
    );
    expect(entrypoint).not.toContain(
      "write_env_file 'OPENAI_API_KEY' '/var/lib/spawnfile/instances/picoclaw/agent-assistant/picoclaw/secrets/OPENAI_API_KEY'"
    );
  });

  it("builds OpenClaw from the pinned runtime artifact image", async () => {
    const node = createAgentNode("openclaw");
    const compiled = await openClawAdapter.compileAgent(node);

    const result = await createContainerArtifacts(createPlan(["openclaw"]), [
      {
        emittedFiles: compiled.files,
        kind: "agent",
        runtimeName: "openclaw",
        slug: "assistant",
        value: node
      }
    ]);

    const dockerfile = result.files.find((file) => file.path === "Dockerfile")?.content ?? "";
    const entrypoint = result.files.find((file) => file.path === "entrypoint.sh")?.content ?? "";
    const stateKeepFile = result.files.find(
      (file) =>
        file.path ===
        "container/rootfs/var/lib/spawnfile/instances/openclaw/agent-assistant/home/.openclaw/agents/main/sessions/.keep"
    );

    expect(dockerfile).toContain("FROM node:24-bookworm-slim");
    expect(dockerfile).toContain("USER root");
    expect(dockerfile).toContain(
      "COPY --from=noopolis/spawnfile-runtime-openclaw:2026.6.11 /opt/spawnfile/runtime-installs/openclaw /opt/spawnfile/runtime-installs/openclaw"
    );
    expect(dockerfile).not.toContain("ghcr.io/openclaw/openclaw");
    expect(dockerfile).not.toContain("runtime-sources");
    expect(dockerfile).not.toContain("pnpm build:docker");
    expect(entrypoint).toContain(
      "'/opt/spawnfile/runtime-installs/openclaw/openclaw.mjs'"
    );
    expect(stateKeepFile?.content).toBe("");
  });

  it("renders recipe.env NOOPOLIS_RUN_ID into the container run-time env, never the Dockerfile build layer", async () => {
    const node = createAgentNode("openclaw");
    const compiled = await openClawAdapter.compileAgent(node);

    vi.spyOn(runtimeIndex, "createRuntimeInstallRecipe").mockResolvedValue({
      commands: [],
      copyCommands: [],
      env: { NOOPOLIS_RUN_ID: "run-abc123" },
      runtimeName: "openclaw",
      runtimeRoot: "/usr/local/lib/node_modules/openclaw"
    });

    const result = await createContainerArtifacts(createPlan(["openclaw"]), [
      {
        emittedFiles: compiled.files,
        kind: "agent",
        runtimeName: "openclaw",
        slug: "assistant",
        value: node
      }
    ]);

    const dockerfile = result.files.find((file) => file.path === "Dockerfile")?.content ?? "";
    const entrypoint = result.files.find((file) => file.path === "entrypoint.sh")?.content ?? "";

    expect(entrypoint).toContain("NOOPOLIS_RUN_ID='run-abc123'");
    expect(dockerfile).not.toContain("NOOPOLIS_RUN_ID");
  });

  it("emits no NOOPOLIS_RUN_ID assignment when the recipe env is empty", async () => {
    const node = createAgentNode("openclaw");
    const compiled = await openClawAdapter.compileAgent(node);

    vi.spyOn(runtimeIndex, "createRuntimeInstallRecipe").mockResolvedValue({
      commands: [],
      copyCommands: [],
      env: {},
      runtimeName: "openclaw",
      runtimeRoot: "/usr/local/lib/node_modules/openclaw"
    });

    const result = await createContainerArtifacts(createPlan(["openclaw"]), [
      {
        emittedFiles: compiled.files,
        kind: "agent",
        runtimeName: "openclaw",
        slug: "assistant",
        value: node
      }
    ]);

    const entrypoint = result.files.find((file) => file.path === "entrypoint.sh")?.content ?? "";
    expect(entrypoint).not.toContain("NOOPOLIS_RUN_ID");
  });

  it("does not hard-require model auth env vars in the generated entrypoint", async () => {
    const node = createAgentNode("openclaw", {
      execution: {
        model: {
          primary: {
            name: "gpt-5",
            provider: "openai"
          }
        }
      }
    });
    const compiled = await openClawAdapter.compileAgent(node);

    const result = await createContainerArtifacts(createPlan(["openclaw"]), [
      {
        emittedFiles: compiled.files,
        kind: "agent",
        runtimeName: "openclaw",
        slug: "assistant",
        value: node
      }
    ]);

    const entrypoint = result.files.find((file) => file.path === "entrypoint.sh")?.content ?? "";
    const envExample = result.files.find((file) => file.path === ".env.example")?.content ?? "";

    expect(result.report.model_secrets_required).toEqual(["OPENAI_API_KEY"]);
    expect(envExample).toContain("OPENAI_API_KEY=");
    expect(entrypoint).not.toContain("require_env 'OPENAI_API_KEY'");
    expect(entrypoint).toContain("require_env 'OPENCLAW_GATEWAY_TOKEN'");
  });

  it("fails when a runtime emits files outside config or workspace", async () => {
    const node = createAgentNode("openclaw");
    const compiled = await openClawAdapter.compileAgent(node);

    await expect(
      createContainerArtifacts(createPlan(["openclaw"]), [
        {
          emittedFiles: [...compiled.files, { content: "not-supported\n", path: "NOTES.txt" }],
          kind: "agent",
          runtimeName: "openclaw",
          slug: "assistant",
          value: node
        }
      ])
    ).rejects.toThrow(/unsupported path NOTES\.txt/);
  });

  it("rejects conflicting package versions for a shared container target", async () => {
    const firstNode = createAgentNode("openclaw", {
      packages: [
        {
          id: "system-curl-1",
          manager: "apt",
          name: "curl",
          version: "1"
        }
      ]
    });
    const secondNode = createAgentNode("openclaw", {
      name: "writer",
      packages: [
        {
          id: "system-curl-2",
          manager: "apt",
          name: "curl",
          version: "2"
        }
      ]
    });

    const firstCompiled = await openClawAdapter.compileAgent(firstNode);
    const secondCompiled = await openClawAdapter.compileAgent(secondNode);

    vi.spyOn(runtimeIndex, "getRuntimeAdapter").mockReturnValue({
      ...openClawAdapter,
      createContainerTargets: vi.fn(async (inputs: ContainerTargetInput[]) => [
        {
          files: firstCompiled.files,
          id: "openclaw-shared",
          sourceIds: inputs.map((input) => input.id)
        }
      ])
    });
    vi.spyOn(runtimeIndex, "createRuntimeInstallRecipe").mockResolvedValue({
      commands: [],
      copyCommands: [],
      env: {},
      runtimeName: "openclaw",
      runtimeRoot: "/opt/runtime/openclaw"
    });

    await expect(
      createRuntimeTargetPlans(createPlan(["openclaw"]), [
        {
          emittedFiles: firstCompiled.files,
          kind: "agent",
          runtimeName: "openclaw",
          slug: "assistant",
          value: firstNode
        },
        {
          emittedFiles: secondCompiled.files,
          kind: "agent",
          runtimeName: "openclaw",
          slug: "writer",
          value: secondNode
        }
      ])
    ).rejects.toThrow(
      "Container target openclaw-shared declares conflicting package definitions for apt package curl"
    );
  });

  it("records engine: scripted for a pi runtime instance on the compile report (Piece 5 disclosure)", async () => {
    const fixtureRoot = fileURLToPath(
      new URL("../../fixtures/support/scripted-engine", import.meta.url)
    );
    const node = createPiTestNode({
      name: "eleanor",
      runtime: { name: "pi", options: { engine: "scripted", engine_command: "office-engine.mjs" } },
      source: path.join(fixtureRoot, "Spawnfile")
    });
    const compiled = await piAdapter.compileAgent(node);

    const result = await createContainerArtifacts(createPlan(["pi"]), [
      {
        emittedFiles: compiled.files,
        id: "agent:eleanor",
        kind: "agent",
        runtimeName: "pi",
        slug: "eleanor",
        value: node
      }
    ]);

    expect(result.report.runtime_instances).toEqual([
      expect.objectContaining({
        engine_by_node_id: { "agent:eleanor": "scripted" },
        id: "pi-app",
        runtime: "pi"
      })
    ]);
  });
});

describe("createContainerArtifacts distribution contract", () => {
  const compileDistributionFixture = async () => {
    const node = createAgentNode("openclaw", { name: "Research Cell" });
    const compiled = await openClawAdapter.compileAgent(node);
    return createContainerArtifacts(
      createPlan(["openclaw"]),
      [
        {
          emittedFiles: compiled.files,
          id: "agent:research-cell",
          kind: "agent",
          runtimeName: "openclaw",
          slug: "research-cell",
          value: node
        }
      ],
      { generatedAt: "2026-06-13T00:00:00.000Z" }
    );
  };

  it("emits the distribution report file and labeled Dockerfile COPY", async () => {
    const result = await compileDistributionFixture();
    const reportFile = result.files.find((file) => file.path === "distribution-report.json");
    const dockerfile = result.files.find((file) => file.path === "Dockerfile");

    expect(reportFile).toBeDefined();
    expect(dockerfile?.content).toContain(
      "COPY distribution-report.json /spawnfile/spawnfile-report.json"
    );
    expect(dockerfile?.content).toContain(
      "LABEL com.spawnfile.image_contract='spawnfile.image.v1'"
    );
    expect(dockerfile?.content).toContain("LABEL com.spawnfile.project='Research-Cell'");
    expect(dockerfile?.content).toContain(
      `LABEL com.spawnfile.compile_fingerprint='${result.distribution.fingerprint}'`
    );
    expect(dockerfile?.content).toContain(
      "LABEL com.spawnfile.report='/spawnfile/spawnfile-report.json'"
    );
  });

  it("keeps the embedded report secret-free and creator-path-free", async () => {
    const result = await compileDistributionFixture();
    const serialized = JSON.stringify(result.distribution.report);

    expect(serialized).not.toContain("/tmp/");
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain(".spawn");
    expect(serialized).not.toContain("volume_name");
  });

  it("derives the project from the manifest name, not the checkout directory", async () => {
    const result = await compileDistributionFixture();
    expect(result.distribution.report.organization.project).toBe("Research Cell");
    expect(result.distribution.labels["com.spawnfile.project"]).toBe("Research-Cell");
  });

  it("marks generated runtime secrets and keeps category alignment", async () => {
    const result = await compileDistributionFixture();
    const runtimeSecrets = result.distribution.report.secrets.runtime;
    const gateway = runtimeSecrets.find((entry) => entry.name === "OPENCLAW_GATEWAY_TOKEN");

    expect(gateway).toEqual({ generated: true, name: "OPENCLAW_GATEWAY_TOKEN", required: true });
    expect(Object.keys(result.distribution.report.secrets).sort()).toEqual([
      "model",
      "project",
      "runtime",
      "surface"
    ]);
  });

  it("reuses the distribution fingerprint as the compile fingerprint source", async () => {
    const result = await compileDistributionFixture();
    expect(result.distribution.fingerprint).toBe(
      result.distribution.report.compile_fingerprint
    );
    expect(result.distribution.fingerprint).toMatch(/^sf1:[0-9a-f]{12}$/);
  });

  it("lists runtime instances with node ids and provider-keyed auth methods", async () => {
    const result = await compileDistributionFixture();
    const instance = result.distribution.report.runtime_instances[0];

    expect(instance?.node_ids).toEqual(["agent:research-cell"]);
    expect(Array.isArray(instance?.model_auth_methods)).toBe(false);
  });

  /**
   * `specs/SURFACES.md` promises a Moltnet release without `daimon-bridge` is
   * rejected. No published release implements the daimon node runtime kind, and
   * the node config decodes with DisallowUnknownFields, so an ungated compile
   * ships a container that dies at boot on strict decode of `agent_id`. A node
   * plan carries `receiptStorePath` if and only if its agent runtime is daimon.
   */
  const piBridgeRelease = {
    architecture: "amd64",
    asset: "moltnet_linux_amd64.tar.gz",
    asset_sha256: `sha256:${"a".repeat(64)}`,
    capabilities: ["pi-bridge"],
    release_version: "v0.1.14",
    source_revision: "b".repeat(40),
    version: "spawnfile.moltnet-release-identity.v1"
  } as const;
  const daimonBridgeRelease = {
    architecture: "amd64",
    asset: "moltnet_linux_amd64.tar.gz",
    asset_sha256: `sha256:${"a".repeat(64)}`,
    capabilities: ["daimon-bridge", "pi-bridge"],
    development: { mode: "local-development", non_production: true, unpublished: true, unsigned: true },
    source_sha256: `sha256:${"c".repeat(64)}`,
    version: "spawnfile.moltnet-release-identity.v1"
  } as const;
  const moltnetWith = (nodePlans: { configPath: string; networkId: string; receiptStorePath?: string }[]) => ({
    files: [], nodePlans, persistentMounts: [], ports: [], publishedPorts: [], serverPlans: []
  });
  const daimonPlans = moltnetWith([{
    configPath: "/etc/spawnfile/moltnet/mapper.json",
    networkId: "daimon_lab",
    receiptStorePath: "/var/lib/spawnfile/moltnet/networks/daimon_lab/daimon-receipts/mapper.json"
  }]);

  const compileWith = (moltnet: unknown, moltnetRelease: unknown) => createContainerArtifacts(
    createPlan(["openclaw"]),
    [],
    { hasStagedMoltnetBinaries: true, moltnet, moltnetRelease } as never
  );

  it("rejects a daimon Moltnet attachment when the staged release lacks daimon-bridge", async () => {
    await expect(compileWith(daimonPlans, piBridgeRelease)).rejects.toThrow(/daimon-bridge/u);

    const thrown: unknown = await compileWith(daimonPlans, piBridgeRelease).catch((error: unknown) => error);
    const message = thrown instanceof Error ? thrown.message : "";
    // Name the capability, the affected network, the real consequence, and a way out.
    expect(message).toContain("daimon-bridge");
    expect(message).toContain("daimon_lab");
    expect(message).toContain("exit at boot");
    expect(message).toContain("build-local-moltnet.mjs");
  });

  it("fails closed when a daimon Moltnet attachment has no staged release identity at all", async () => {
    await expect(compileWith(daimonPlans, undefined)).rejects.toThrow(/daimon-bridge/u);
  });

  it("admits a daimon Moltnet attachment when the staged release advertises daimon-bridge", async () => {
    const thrown: unknown = await compileWith(daimonPlans, daimonBridgeRelease).catch((error: unknown) => error);
    expect(thrown instanceof Error ? thrown.message : "").not.toContain("daimon-bridge");
  });

  /**
   * THE TRANSITION. Before moltnet v0.1.18 no published release advertised
   * `daimon-bridge`, so the fail-closed gate rejected every daimon attachment —
   * correctly, because the pinned binary rejected the config at strict decode.
   * Now the checked-in authority advertises it, so the same organization must
   * compile. Nothing else pins that flip, and it is the entire point of the pin.
   */
  it("admits a daimon Moltnet attachment against the checked-in released authority", async () => {
    const authority = await readTrustedMoltnetReleaseAuthority();
    expect(authority.capabilities).toContain("daimon-bridge");
    const releasedIdentity = {
      architecture: "amd64",
      asset: trustedMoltnetReleaseAsset(authority, "amd64").asset,
      asset_sha256: trustedMoltnetReleaseAsset(authority, "amd64").asset_sha256,
      capabilities: authority.capabilities,
      release_version: authority.release_version,
      source_revision: authority.source_revision,
      version: "spawnfile.moltnet-release-identity.v1"
    };

    const thrown: unknown = await compileWith(daimonPlans, releasedIdentity).catch((error: unknown) => error);

    expect(thrown instanceof Error ? thrown.message : "").not.toContain("daimon-bridge");
  });

  it("leaves a pi-only Moltnet attachment on a pi-bridge release alone", async () => {
    const piPlans = moltnetWith([{ configPath: "/etc/spawnfile/moltnet/pi.json", networkId: "lab" }]);
    const thrown: unknown = await compileWith(piPlans, piBridgeRelease).catch((error: unknown) => error);
    expect(thrown instanceof Error ? thrown.message : "").not.toContain("daimon-bridge");
  });
});
