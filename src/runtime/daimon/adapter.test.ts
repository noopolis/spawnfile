import { describe, expect, it } from "vitest";

import { createRootfsFiles } from "../../compiler/containerArtifactsRender.js";
import { renderEntrypoint } from "../../compiler/containerEntrypointRender.js";
import { resolveInstancePaths } from "../../compiler/containerTargetPlanResolution.js";
import type { RuntimeTargetPlan } from "../../compiler/containerArtifactsTypes.js";
import { createMoltnetNodeConfigContent } from "../../compiler/moltnetNodeConfig.js";
import { resolveRuntimeConfig } from "../../compiler/moltnetRuntimeConfig.js";
import type { CompilePlan } from "../../compiler/types.js";
import { createRuntimeInstallRecipe } from "../container.js";
import { createPiTestNode } from "../pi/testHelpers.js";

import { daimonAdapter } from "./adapter.js";
import { DAIMON_CONFIG_FILE } from "./config.js";

const createDaimonNode = (id: string, name = id, engine = "codex") => {
  const node = createPiTestNode({
    name,
    runtime: { name: "daimon", options: { engine } }
  });
  if (engine === "codex") return node;
  const { model: _model, ...execution } = node.execution!;
  return { ...node, execution };
};

const createPlan = async (): Promise<RuntimeTargetPlan> => {
  const first = createDaimonNode("first", "First");
  const second = createDaimonNode("second", "Second");
  const firstCompiled = await daimonAdapter.compileAgent(first);
  const secondCompiled = await daimonAdapter.compileAgent(second);
  const target = (await daimonAdapter.createContainerTargets!([
    { emittedFiles: firstCompiled.files, id: "agent:first", kind: "agent", slug: "first", value: first },
    { emittedFiles: secondCompiled.files, id: "agent:second", kind: "agent", slug: "second", value: second }
  ]))[0]!;
  const instancePaths = resolveInstancePaths("daimon", target.id, daimonAdapter.container);
  return {
    engineByNodeId: target.engineByNodeId,
    envFiles: [],
    id: target.id,
    instancePaths,
    meta: daimonAdapter.container,
    modelAuthMethods: {},
    modelSecretsRequired: [],
    port: daimonAdapter.container.port,
    recipeEnv: {},
    runtimeName: "daimon",
    runtimeRoot: "/opt/spawnfile/runtime-installs/daimon",
    sourceIds: target.sourceIds,
    targetFiles: target.files
  };
};

describe("daimonAdapter", () => {
  it("emits one strict organization host and no generated engine application", async () => {
    const plan = await createPlan();
    const config = plan.targetFiles.find((file) => file.path === DAIMON_CONFIG_FILE);

    expect(plan.id).toBe("daimon-organization");
    expect(plan.targetFiles.some((file) => file.path === "runtime/app.mjs")).toBe(false);
    expect(plan.targetFiles.some((file) => file.path === "runtime/schedule.mjs")).toBe(false);
    expect(JSON.parse(config!.content)).toMatchObject({
      version: "noopolis.daimon.organization-runtime.v1",
      host: { bindHost: "127.0.0.1", controlTokenEnv: "SPAWNFILE_DAIMON_CONTROL_TOKEN", port: 19700 },
      agents: [
        { id: "agent:first", engine: { kind: "codex" } },
        { id: "agent:second", engine: { kind: "codex" } }
      ]
    });
  });

  it("creates physical per-agent roots and invokes only the public daemon command", async () => {
    const plan = await createPlan();
    const rootfs = createRootfsFiles([plan]);
    const config = rootfs.find((file) => file.path.endsWith(`/${DAIMON_CONFIG_FILE}`));
    const start = rootfs.find((file) => file.path.endsWith("/daimon-start.sh"));
    const entrypoint = renderEntrypoint([plan], []);

    expect(config!.content).toContain("/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/first");
    expect(start!.content).toContain("exec daimon-runtime run --config");
    expect(start!.content).toContain("/var/lib/spawnfile/instances/daimon/daimon-organization/daimon/daimon-organization-runtime.json");
    expect(start!.content).not.toContain("<config-path>");
    expect(start!.content).not.toContain("codex exec");
    expect(start!.content).toContain("install -d -m 700");
    expect(start!.content).toContain('if [ "$#" -gt 0 ]; then exec daimon-runtime "$@"; fi');
    expect(start!.content).toContain(".daimon-inbound");
    expect(start!.content).toContain("stat -c %a");
    expect(entrypoint).toContain("'bash' '/opt/spawnfile/runtime-installs/daimon/daimon-start.sh'");
    expect(entrypoint).not.toContain("SPAWNFILE_CLI_AUTH_JSON");
    expect(daimonAdapter.container.systemDeps).toEqual([
      "bash", "ca-certificates", "curl", "dbus-daemon", "gnome-keyring", "util-linux"
    ]);
  });

  it("compiles and mounts a three-engine Moltnet trace without invoking an engine", async () => {
    const agents = (["codex", "grok", "agy"] as const).map((engine) => ({
      id: `agent:${engine}`,
      node: createDaimonNode(engine, engine.toUpperCase(), engine),
      slug: engine
    }));
    const target = (await daimonAdapter.createContainerTargets!(await Promise.all(agents.map(async (agent) => ({
      emittedFiles: (await daimonAdapter.compileAgent(agent.node)).files,
      id: agent.id,
      kind: "agent" as const,
      slug: agent.slug,
      value: agent.node
    })))))[0]!;
    const instancePaths = resolveInstancePaths("daimon", target.id, daimonAdapter.container);
    const runtimePlan: RuntimeTargetPlan = {
      engineByNodeId: target.engineByNodeId,
      envFiles: [], id: target.id, instancePaths, meta: daimonAdapter.container,
      modelAuthMethods: {}, modelSecretsRequired: [], port: daimonAdapter.container.port,
      recipeEnv: {}, runtimeName: "daimon", runtimeRoot: "/opt/spawnfile/runtime-installs/daimon",
      sourceIds: target.sourceIds, targetFiles: target.files
    };
    const compilePlan = { nodes: [] } as unknown as CompilePlan;
    const attachments = agents.map((agent) => JSON.parse(createMoltnetNodeConfigContent({
      agentNode: agent.node,
      attachment: { memberId: agent.id, network: "local", teamSource: null },
      networkServer: { auth: { mode: "none" }, mode: "external", url: "http://127.0.0.1:9999" },
      nodeSlug: agent.slug,
      plan: compilePlan,
      serverPlan: { baseUrl: "http://127.0.0.1:9999", rooms: [] }
    }).content));
    const entrypoint = renderEntrypoint([runtimePlan], [], {
      moltnet: { nodePlans: [{ configPath: "/config/moltnet.json", networkId: "local" }] as any, serverPlans: [] }
    });

    expect(JSON.parse(target.files.find((file) => file.path === DAIMON_CONFIG_FILE)!.content).agents)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ engine: { kind: "codex" } }),
        expect.objectContaining({ engine: { kind: "grok" } }),
        expect.objectContaining({ engine: { kind: "agy" } })
      ]));
    expect(target.opaqueMountTargets).toEqual([
      "/var/lib/spawnfile/daimon/agy-unlock-secret"
    ]);
    expect(target.persistentMounts).toEqual([
      {
        id: "daimon-agy-subscription-realm",
        mountPath: "/var/lib/spawnfile/daimon/agy-subscription-realm",
        reason: "Daimon host AGY subscription realm"
      },
      {
        id: "daimon-agy-runtime-home-agy",
        mountPath: "<instance-root>/runtime-homes/agy",
        reason: "Daimon AGY subscription runtime home for agent:agy"
      }
    ]);
    const start = target.files.find((file) => file.path === "runtime/daimon-start.sh")!;
    expect(start.content.indexOf("/runtime-homes/agy")).toBeLessThan(
      start.content.indexOf('if [ "$#" -gt 0 ]; then exec daimon-runtime "$@"; fi')
    );
    expect(JSON.stringify(target.files)).not.toMatch(
      /DBUS_SESSION_BUS_ADDRESS|gnome-keyring-daemon|antigravity-oauth-token/u
    );
    for (const [index, agent] of agents.entries()) {
      expect(attachments[index].attachments[0].runtime).toEqual(resolveRuntimeConfig(
        compilePlan, agent.node, agent.slug, "local", agent.id
      ));
      expect(attachments[index].attachments[0].runtime).toMatchObject({
        control_url: "http://127.0.0.1:19700",
        kind: "daimon",
        token_env: "SPAWNFILE_DAIMON_CONTROL_TOKEN"
      });
    }
    expect(entrypoint.indexOf("/healthz")).toBeGreaterThan(entrypoint.indexOf("daimon-start.sh"));
    expect(entrypoint.indexOf("moltnet node")).toBeGreaterThan(entrypoint.indexOf("/healthz"));
    expect(entrypoint).not.toContain("Authorization: Bearer");
    expect(entrypoint).not.toMatch(/(?:codex|grok|agy) (?:exec|run)/u);
  });

  it("does not emit AGY state when every agent uses a portable engine", async () => {
    const target = (await daimonAdapter.createContainerTargets!([
      { emittedFiles: [], id: "agent:codex", kind: "agent", slug: "codex", value: createDaimonNode("codex") },
      { emittedFiles: [], id: "agent:grok", kind: "agent", slug: "grok", value: createDaimonNode("grok", "Grok", "grok") }
    ]))[0]!;
    expect(target.opaqueMountTargets).toBeUndefined();
    expect(target.persistentMounts).toBeUndefined();
  });

  it("rejects 33 agents before emitting a partial target", async () => {
    const inputs = Array.from({ length: 33 }, (_, index) => {
      const node = createDaimonNode(`agent-${index}`);
      return {
        emittedFiles: [],
        id: `agent:${index}`,
        kind: "agent" as const,
        slug: `agent-${index}`,
        value: node
      };
    });

    await expect(daimonAdapter.createContainerTargets!(inputs)).rejects.toThrow(
      "Daimon organization runtime v1 supports at most 32 agents; found 33. Split the organization across explicit runtime boundaries."
    );
  });

  it("selects a source-free immutable runtime image", async () => {
    const recipe = await createRuntimeInstallRecipe("daimon");
    expect(recipe.copyCommands).toEqual([
      expect.stringContaining("noopolis/spawnfile-runtime-daimon@sha256:")
    ]);
    expect(recipe.commands.join("\n")).toContain("daimon-runtime");
    expect(recipe.commands.join("\n")).not.toContain("npm install");
  });

  it("fails closed for schedules, MCP, and non-Moltnet Daimon surface behavior", async () => {
    await expect(daimonAdapter.compileAgent(createDaimonNode("schedule", "Schedule"))).resolves.toBeDefined();
    await expect(daimonAdapter.compileAgent(createPiTestNode({
      runtime: { name: "daimon", options: {} },
      schedule: { every: "1m", kind: "every", prompt: "work" }
    }))).rejects.toThrow("does not lower schedules yet");
    await expect(daimonAdapter.compileAgent(createPiTestNode({
      runtime: { name: "daimon", options: { engine: "grok" } }
    }))).rejects.toThrow("must omit Spawnfile execution.model");
    expect(() => daimonAdapter.assertSupportedSurfaces?.({ moltnet: [{ network: "test" }] } as any)).not.toThrow();
    expect(() => daimonAdapter.assertSupportedSurfaces?.({ discord: [{}] } as any)).toThrow("only lowers Moltnet");
  });

  it("validates the complete public model, option, MCP, and empty-target boundaries", async () => {
    expect(() => daimonAdapter.assertSupportedModelTarget?.({
      auth: { method: "codex" }, provider: "openai"
    } as any)).not.toThrow();
    expect(() => daimonAdapter.assertSupportedModelTarget?.({
      auth: { method: "codex" }, endpoint: "https://example.invalid", provider: "openai"
    } as any)).toThrow(/optional OpenAI Codex/u);
    expect(() => daimonAdapter.assertSupportedSurfaces?.({ discord: [], moltnet: [] } as any)).not.toThrow();

    await expect(daimonAdapter.compileAgent({
      ...createDaimonNode("mcp"),
      mcpServers: [{ name: "unsupported" }]
    } as any)).rejects.toThrow(/does not lower MCP/u);
    await expect(daimonAdapter.createContainerTargets!([])).resolves.toEqual([]);

    expect(daimonAdapter.validateRuntimeOptions?.({ engine: 7 } as any)).toEqual([
      expect.objectContaining({ level: "error" })
    ]);
    expect(daimonAdapter.validateRuntimeOptions?.({ engine: "codex", unexpected: true } as any))
      .toEqual([expect.objectContaining({ message: expect.stringContaining("unexpected") })]);
  });

  it("preserves non-workspace files and rejects invalid engines and oversized instructions", async () => {
    const node = createDaimonNode("files");
    const target = (await daimonAdapter.createContainerTargets!([{
      emittedFiles: [{ content: "root\n", path: "root.txt" }],
      id: "agent:files", kind: "agent", slug: "files", value: node
    }]))[0]!;
    expect(target.files).toContainEqual({ content: "root\n", path: "root.txt" });

    expect(daimonAdapter.validateRuntimeOptions?.({ engine: "invalid" }))
      .toEqual([expect.objectContaining({ message: expect.stringContaining("engine must be one of") })]);
    await expect(daimonAdapter.createContainerTargets!([{
      emittedFiles: [], id: "agent:invalid", kind: "agent", slug: "invalid",
      value: createDaimonNode("invalid", "Invalid", "invalid")
    }])).rejects.toThrow(/engine must be one of/u);

    const oversized = {
      ...createDaimonNode("oversized"),
      docs: [{ content: "x".repeat(4_097), path: "AGENTS.md", role: "instructions" }]
    } as any;
    await expect(daimonAdapter.createContainerTargets!([{
      emittedFiles: [], id: "agent:oversized", kind: "agent", slug: "oversized", value: oversized
    }])).rejects.toThrow(/instructions/u);
  });
});
