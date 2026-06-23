import { afterEach, describe, expect, it, vi } from "vitest";

import type { CompilePlan, ResolvedAgentNode } from "./types.js";
import type { ContainerTargetInput } from "../runtime/index.js";
import * as runtimeIndex from "../runtime/index.js";
import { createContainerArtifacts } from "./containerArtifacts.js";
import { createRuntimeTargetPlans } from "./containerArtifactsPlans.js";
import { openClawAdapter } from "../runtime/openclaw/adapter.js";
import { picoClawAdapter } from "../runtime/picoclaw/adapter.js";

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
    expect(result.files.find((file) => file.path === ".env.example")?.content).toContain(
      "OPENCLAW_GATEWAY_TOKEN="
    );
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
      "touch '/var/lib/spawnfile/moltnet/networks/local-lab/.spawnfile-volume-init'"
    );
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
        sharing: "per_agent"
      },
      {
        backing_path: expect.stringContaining("/var/lib/spawnfile/resources/instances/agent-assistant-"),
        id: "project",
        kind: "git",
        link_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home/.openclaw/workspace/repos/project",
        mode: "mutable",
        mount: "./repos/project",
        sharing: "per_agent"
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
      "COPY --from=noopolis/spawnfile-runtime-picoclaw:0.2.9 /opt/spawnfile/runtime-installs/picoclaw /opt/spawnfile/runtime-installs/picoclaw"
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

    expect(result.report.model_secrets_required).toEqual([]);
    expect(result.report.runtime_instances).toEqual([
      {
        config_path: "/var/lib/spawnfile/instances/picoclaw/agent-assistant/picoclaw/config.json",
        home_path: "/var/lib/spawnfile/instances/picoclaw/agent-assistant/picoclaw",
        id: "agent-assistant",
        internal_port: 18990,
        model_auth_methods: {
          openai: "codex"
        },
        model_secrets_required: [],
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
      "COPY --from=noopolis/spawnfile-runtime-openclaw:2026.6.8 /opt/spawnfile/runtime-installs/openclaw /opt/spawnfile/runtime-installs/openclaw"
    );
    expect(dockerfile).not.toContain("ghcr.io/openclaw/openclaw");
    expect(dockerfile).not.toContain("runtime-sources");
    expect(dockerfile).not.toContain("pnpm build:docker");
    expect(entrypoint).toContain(
      "'/opt/spawnfile/runtime-installs/openclaw/openclaw.mjs'"
    );
    expect(stateKeepFile?.content).toBe("");
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
});
