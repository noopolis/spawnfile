import { describe, expect, it } from "vitest";

import type { CompilePlan, ResolvedAgentNode } from "./types.js";
import { createContainerArtifacts } from "./containerArtifacts.js";
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
    expect(result.report.ports).toEqual([18789, 18790]);

    const envExample = result.files.find((file) => file.path === ".env.example")?.content ?? "";
    expect(envExample).toContain("OPENCLAW_GATEWAY_TOKEN=");
    expect(envExample).toContain("PROXY_API_API_KEY=");
    expect(envExample).toContain("SHARED_TOKEN=");
  });

  it("uses the standalone Go base image for PicoClaw-only output", async () => {
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

    expect(dockerfile).toContain("FROM golang:1.25-bookworm");
    expect(dockerfile).not.toContain("corepack enable");
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
