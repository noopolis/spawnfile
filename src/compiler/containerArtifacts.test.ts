import { describe, expect, it } from "vitest";

import type { CompilePlan, ResolvedAgentNode } from "./types.js";
import { createContainerArtifacts } from "./containerArtifacts.js";
import { openClawAdapter } from "../runtime/openclaw/adapter.js";
import { picoClawAdapter } from "../runtime/picoclaw/adapter.js";
import { tinyClawAdapter } from "../runtime/tinyclaw/adapter.js";

const createPlan = (runtimeNames: string[]): CompilePlan => ({
  edges: [],
  nodes: [],
  root: "/tmp/Spawnfile",
  runtimes: Object.fromEntries(runtimeNames.map((runtimeName) => [runtimeName, { nodeIds: [] }]))
});

const createAgentNode = (
  runtimeName: "openclaw" | "picoclaw" | "tinyclaw",
  overrides: Partial<ResolvedAgentNode> = {}
): ResolvedAgentNode => ({
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
      secrets: [{ name: "SHARED_TOKEN", required: false }]
    });
    const secondNode = createAgentNode("openclaw", {
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
    expect(result.report.ports).toEqual([18789, 18790]);
    expect(result.report.runtime_instances).toEqual([
      {
        config_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home/.openclaw/openclaw.json",
        home_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home",
        id: "agent-assistant",
        model_auth_methods: {
          "proxy-api": "api_key"
        },
        model_secrets_required: ["PROXY_API_API_KEY"],
        runtime: "openclaw"
      },
      {
        config_path: "/var/lib/spawnfile/instances/openclaw/agent-writer/home/.openclaw/openclaw.json",
        home_path: "/var/lib/spawnfile/instances/openclaw/agent-writer/home",
        id: "agent-writer",
        model_auth_methods: {},
        model_secrets_required: [],
        runtime: "openclaw"
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
      "https://github.com/sipeed/picoclaw/releases/download/v0.2.3/$asset"
    );
    expect(dockerfile).toContain(
      'ln -sf /opt/spawnfile/runtime-installs/picoclaw/bin/picoclaw /usr/local/bin/picoclaw'
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

  it("builds OpenClaw from the pinned npm package", async () => {
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

    expect(dockerfile).toContain("FROM node:24-bookworm-slim");
    expect(dockerfile).toContain("USER root");
    expect(dockerfile).toContain("RUN npm install -g --omit=dev --no-fund --no-audit openclaw@2026.3.13");
    expect(dockerfile).not.toContain("ghcr.io/openclaw/openclaw");
    expect(dockerfile).not.toContain("runtime-sources");
    expect(dockerfile).not.toContain("pnpm build:docker");
    expect(entrypoint).toContain(
      "'/usr/local/lib/node_modules/openclaw/openclaw.mjs'"
    );
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

  it("patches TinyClaw auth tokens from env into settings.json at startup", async () => {
    const node = createAgentNode("tinyclaw", {
      execution: {
        model: {
          primary: {
            name: "claude-sonnet-4-6",
            provider: "anthropic"
          }
        }
      }
    });
    const compiled = await tinyClawAdapter.compileAgent(node);

    const result = await createContainerArtifacts(createPlan(["tinyclaw"]), [
      {
        emittedFiles: compiled.files,
        kind: "agent",
        runtimeName: "tinyclaw",
        slug: "assistant",
        value: node
      }
    ]);

    const entrypoint = result.files.find((file) => file.path === "entrypoint.sh")?.content ?? "";

    expect(result.report.model_secrets_required).toEqual(["ANTHROPIC_API_KEY"]);
    expect(result.report.runtime_instances).toEqual([
      {
        config_path: "/var/lib/spawnfile/instances/tinyclaw/tinyclaw-runtime/tinyagi/settings.json",
        home_path: "/var/lib/spawnfile/instances/tinyclaw/tinyclaw-runtime/tinyagi",
        id: "tinyclaw-runtime",
        model_auth_methods: {
          anthropic: "api_key"
        },
        model_secrets_required: ["ANTHROPIC_API_KEY"],
        runtime: "tinyclaw"
      }
    ]);
    expect(result.report.runtime_homes).toEqual([
      "/var/lib/spawnfile/instances/tinyclaw/tinyclaw-runtime/tinyagi"
    ]);
    expect(entrypoint).toContain("apply_json_env_value");
    expect(entrypoint).toContain(
      "apply_json_env_value '/var/lib/spawnfile/instances/tinyclaw/tinyclaw-runtime/tinyagi/settings.json' 'ANTHROPIC_API_KEY' 'models.anthropic.auth_token'"
    );
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
});
