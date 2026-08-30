import { describe, expect, it } from "vitest";

import { createRootfsFiles } from "../../compiler/containerArtifactsRender.js";
import { renderEntrypoint } from "../../compiler/containerEntrypointRender.js";
import { resolveInstancePaths } from "../../compiler/containerTargetPlanResolution.js";
import type { RuntimeTargetPlan } from "../../compiler/containerArtifactsTypes.js";
import { resolveMoltnetWorkspaceLayout } from "../../compiler/moltnetClientConfig.js";
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
    runtime: { name: "daimon", options: { engine } },
    source: `/tmp/agent/${id}/Spawnfile`
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
  it("emits declared skills into the roots Moltnet installs its own skill into", async () => {
    const compiled = await daimonAdapter.compileAgent(createDaimonNode("first", "First"));
    // The Moltnet skill is the working reference: it is the one skill that
    // demonstrably reaches the engine in a running Daimon container, and it
    // is installed into these roots. Declared skills must use the same ones.
    const moltnetSkillRoots = resolveMoltnetWorkspaceLayout("daimon", "First").skillPaths.map(
      (skillPath) => skillPath.replace(/\/moltnet\/SKILL\.md$/, "")
    );

    expect(moltnetSkillRoots).toEqual(["workspace/.agents/skills", "workspace/.codex/skills"]);
    expect(
      compiled.files.map((file) => file.path).filter((filePath) => filePath.endsWith("/SKILL.md"))
    ).toEqual(moltnetSkillRoots.map((root) => `${root}/note/SKILL.md`));
    expect(compiled.files.some((file) => file.path.startsWith("workspace/skills/"))).toBe(false);
  });

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
      "bash", "bubblewrap", "ca-certificates", "curl", "dbus-daemon", "gnome-keyring", "util-linux"
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
    const compilePlan = { nodes: agents.map((agent) => ({
      id: agent.id, kind: "agent", runtimeName: "daimon", slug: agent.slug, value: agent.node
    })) } as unknown as CompilePlan;
    const attachments = agents.map((agent) => JSON.parse(createMoltnetNodeConfigContent({
      agentNode: agent.node,
      attachment: { memberId: agent.slug, network: "local", teamSource: null },
      networkServer: { auth: { mode: "none" }, mode: "external", url: "http://127.0.0.1:9999" },
      nodeSlug: agent.slug,
      plan: compilePlan,
      serverPlan: { baseUrl: "http://127.0.0.1:9999", rooms: [] }
    }).content));
    const entrypoint = renderEntrypoint([runtimePlan], [], {
      moltnet: { nodePlans: [{ configPath: "/config/moltnet.json", networkId: "local", receiptStorePath: "/var/lib/spawnfile/moltnet/networks/local/daimon-receipts/codex.json" }] as any, serverPlans: [] }
    });

    expect(JSON.parse(target.files.find((file) => file.path === DAIMON_CONFIG_FILE)!.content).agents)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ engine: { kind: "codex" } }),
        expect.objectContaining({ engine: { kind: "grok" } }),
        expect.objectContaining({ engine: { kind: "agy" } })
      ]));
    expect(target.opaqueMountTargets).toEqual([
      "/var/lib/spawnfile/daimon/agy-unlock-secret",
      "/var/lib/spawnfile/daimon/grok-bootstrap-auth"
    ]);
    expect(target.persistentMounts).toEqual([
      {
        id: "daimon-engine-home-codex-codex",
        mountPath: "<instance-root>/runtime-homes/codex/.codex",
        reason: "Daimon codex subscription credential home for agent:codex"
      },
      {
        id: "daimon-engine-home-grok-grok",
        mountPath: "<instance-root>/runtime-homes/grok/.grok",
        reason: "Daimon grok subscription credential home for agent:grok"
      },
      {
        id: "daimon-tool-state-agy",
        mountPath: "<instance-root>/runtime-homes/agy/tool-state",
        reason: "Daimon durable cognition tool receipts for agent:agy"
      },
      {
        id: "daimon-tool-state-codex",
        mountPath: "<instance-root>/runtime-homes/codex/tool-state",
        reason: "Daimon durable cognition tool receipts for agent:codex"
      },
      {
        id: "daimon-tool-state-grok",
        mountPath: "<instance-root>/runtime-homes/grok/tool-state",
        reason: "Daimon durable cognition tool receipts for agent:grok"
      },
      {
        id: "daimon-organization-acceptance-store",
        mountPath: "<instance-root>/state/wake-acceptance",
        reason: "Daimon organization durable wake acceptance store"
      },
      {
        id: "daimon-grok-subscription-realm",
        lifecycle: "exclusive-reattach",
        mountPath: "/var/lib/spawnfile/daimon/grok-subscription-realm",
        reason: "Daimon host Grok subscription credential realm"
      },
      {
        id: "daimon-grok-usage-ledger",
        lifecycle: "exclusive-reattach",
        mountPath: "/var/lib/spawnfile/daimon/usage",
        reason: "Daimon per-turn engine usage ledger"
      },
      {
        id: "daimon-agy-subscription-realm",
        lifecycle: "exclusive-reattach",
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
    expect(start.content).toContain(
      'export DAIMON_RUNTIME_ACCEPTANCE_STORE="<instance-root>/state/wake-acceptance"'
    );
    expect(start.content.indexOf("/runtime-homes/agy")).toBeLessThan(
      start.content.indexOf('if [ "$#" -gt 0 ]; then exec daimon-runtime "$@"; fi')
    );
    expect(JSON.stringify(target.files)).not.toMatch(
      /DBUS_SESSION_BUS_ADDRESS|gnome-keyring-daemon|antigravity-oauth-token/u
    );
    for (const [index, agent] of agents.entries()) {
      expect(attachments[index].attachments[0].runtime).toEqual(resolveRuntimeConfig(
        compilePlan, agent.node, agent.slug, "local", agent.slug
      ));
      expect(attachments[index].attachments[0].runtime).toMatchObject({
        agent_id: agent.id,
        control_url: "http://127.0.0.1:19700",
        kind: "daimon",
        receipt_store_path: `/var/lib/spawnfile/moltnet/networks/local/daimon-receipts/${agent.slug}.json`,
        token_env: "SPAWNFILE_DAIMON_CONTROL_TOKEN"
      });
      expect(attachments[index].attachments[0].agent.id).toBe(agent.slug);
    }
    expect(entrypoint.indexOf("/healthz")).toBeGreaterThan(entrypoint.indexOf("daimon-start.sh"));
    expect(entrypoint.indexOf("moltnet node")).toBeGreaterThan(entrypoint.indexOf("/healthz"));
    expect(entrypoint).toContain("install -d -m 700 '/var/lib/spawnfile/moltnet/networks/local/daimon-receipts'");
    expect(entrypoint).not.toContain("Authorization: Bearer");
    expect(entrypoint).not.toMatch(/(?:codex|grok|agy) (?:exec|run)/u);
  });

  it("emits only isolated portable credential homes when no agent uses AGY", async () => {
    const target = (await daimonAdapter.createContainerTargets!([
      { emittedFiles: [], id: "agent:codex", kind: "agent", slug: "codex", value: createDaimonNode("codex") },
      { emittedFiles: [], id: "agent:grok", kind: "agent", slug: "grok", value: createDaimonNode("grok", "Grok", "grok") }
    ]))[0]!;
    expect(target.opaqueMountTargets).toEqual(["/var/lib/spawnfile/daimon/grok-bootstrap-auth"]);
    expect(target.persistentMounts).toEqual([
      {
        id: "daimon-engine-home-codex-codex",
        mountPath: "<instance-root>/runtime-homes/codex/.codex",
        reason: "Daimon codex subscription credential home for agent:codex"
      },
      {
        id: "daimon-engine-home-grok-grok",
        mountPath: "<instance-root>/runtime-homes/grok/.grok",
        reason: "Daimon grok subscription credential home for agent:grok"
      },
      {
        id: "daimon-tool-state-codex",
        mountPath: "<instance-root>/runtime-homes/codex/tool-state",
        reason: "Daimon durable cognition tool receipts for agent:codex"
      },
      {
        id: "daimon-tool-state-grok",
        mountPath: "<instance-root>/runtime-homes/grok/tool-state",
        reason: "Daimon durable cognition tool receipts for agent:grok"
      },
      {
        id: "daimon-organization-acceptance-store",
        mountPath: "<instance-root>/state/wake-acceptance",
        reason: "Daimon organization durable wake acceptance store"
      },
      {
        id: "daimon-grok-subscription-realm",
        lifecycle: "exclusive-reattach",
        mountPath: "/var/lib/spawnfile/daimon/grok-subscription-realm",
        reason: "Daimon host Grok subscription credential realm"
      },
      {
        id: "daimon-grok-usage-ledger",
        lifecycle: "exclusive-reattach",
        mountPath: "/var/lib/spawnfile/daimon/usage",
        reason: "Daimon per-turn engine usage ledger"
      }
    ]);
    expect(target.persistentMounts?.some((mount) =>
      mount.mountPath.includes(".daimon-inbound")
    )).toBe(false);
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

  it("rejects the pinned image until it attests the exact compiler contract", async () => {
    await expect(createRuntimeInstallRecipe("daimon")).rejects.toThrow(/exact contract manifest/u);
  });

  it("lowers schedules while retaining the MCP and non-Moltnet surface boundary", async () => {
    await expect(daimonAdapter.compileAgent(createDaimonNode("schedule", "Schedule"))).resolves.toBeDefined();
    await expect(daimonAdapter.compileAgent(createPiTestNode({
      runtime: { name: "daimon", options: {} },
      schedule: { every: "1m", kind: "every", prompt: "work" }
    }))).resolves.toMatchObject({ capabilities: expect.arrayContaining([
      expect.objectContaining({ key: "agent.schedule", outcome: "degraded" })
    ]) });
    await expect(daimonAdapter.compileAgent(createPiTestNode({
      runtime: { name: "daimon", options: {} },
      schedule: { kind: "disabled" }
    }))).resolves.toMatchObject({ capabilities: expect.arrayContaining([
      expect.objectContaining({ key: "agent.schedule", outcome: "degraded" })
    ]) });
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
    } as any)).rejects.toThrow(/explicit tools allowlist/u);
    await expect(daimonAdapter.createContainerTargets!([])).resolves.toEqual([]);

    expect(daimonAdapter.validateRuntimeOptions?.({ engine: 7 } as any)).toEqual([
      expect.objectContaining({ level: "error" })
    ]);
    expect(daimonAdapter.validateRuntimeOptions?.({ engine: "codex", unexpected: true } as any))
      .toEqual([expect.objectContaining({ message: expect.stringContaining("unexpected") })]);
  });

  it("lowers declared production MCP and scoped Moltnet cognition capabilities", async () => {
    const node = { ...createDaimonNode("tools"), mcpServers: [{ name: "lifecycle", transport: "stdio", command: "/opt/tools/lifecycle", args: ["serve"], tools: ["checkpoint"], env: {} }], surfaces: { moltnet: [{ network: "news", rooms: { desk: { wake: "all" } }, dms: { enabled: false } }] } } as any;
    const compiled = await daimonAdapter.compileAgent(node);
    const target = (await daimonAdapter.createContainerTargets!([{ emittedFiles: compiled.files, id: "agent:tools", kind: "agent", slug: "tools", value: node }]))[0]!;
    const agent = JSON.parse(target.files.find((file) => file.path === DAIMON_CONFIG_FILE)!.content).agents[0];
    expect(agent.mcp).toEqual([{ name: "lifecycle", transport: "stdio", command: "/opt/tools/lifecycle", args: ["serve"], env: {}, tools: ["checkpoint"] }]);
    expect(agent.moltnet).toEqual({ cliPath: "/usr/local/bin/moltnet", configPath: "<workspace-path>/agents/tools/.moltnet/config.json", networks: [{ id: "news", rooms: ["desk"], dms: false }] });
    expect(compiled.capabilities).toEqual(expect.arrayContaining([expect.objectContaining({ key: "mcp.lifecycle", outcome: "supported" }), expect.objectContaining({ key: "surfaces.moltnet", outcome: "supported" })]));

    const remote = { ...createDaimonNode("remote"), mcpServers: [{ name: "search", transport: "streamable_http", url: "https://mcp.example/tools", auth: { mode: "bearer", secret: "MCP_TOKEN" }, tools: ["query"] }], surfaces: { moltnet: [{ network: "private", dms: { enabled: true } }] } } as any;
    const remoteCompiled = await daimonAdapter.compileAgent(remote);
    const remoteTarget = (await daimonAdapter.createContainerTargets!([{ emittedFiles: remoteCompiled.files, id: "agent:remote", kind: "agent", slug: "remote", value: remote }]))[0]!;
    const remoteAgent = JSON.parse(remoteTarget.files.find((file) => file.path === DAIMON_CONFIG_FILE)!.content).agents[0];
    expect(remoteAgent.mcp).toEqual([{ name: "search", transport: "streamable_http", url: "https://mcp.example/tools", authSecretEnv: "MCP_TOKEN", args: [], env: {}, tools: ["query"] }]);
    expect(remoteAgent.moltnet.networks).toEqual([{ id: "private", rooms: [], dms: true }]);
  });

  it("fails closed for unsafe or unavailable production cognition authorities", async () => {
    const base = createDaimonNode("unsafe");
    await expect(daimonAdapter.compileAgent({ ...base, mcpServers: [{ name: "missing", transport: "stdio", command: "/bin/tool" }] } as any)).rejects.toThrow(/tools allowlist/u);
    await expect(daimonAdapter.compileAgent({ ...base, mcpServers: [{ name: "relative", transport: "stdio", command: "tool", tools: ["act"] }] } as any)).rejects.toThrow(/absolute command/u);
    const agy = createDaimonNode("agy-tools", "agy-tools", "agy");
    // The same two MCP validations apply to AGY as to every other engine.
    await expect(daimonAdapter.compileAgent({ ...agy, mcpServers: [{ name: "missing", transport: "stdio", command: "/bin/tool" }] } as any)).rejects.toThrow(/tools allowlist/u);
    await expect(daimonAdapter.compileAgent({ ...agy, mcpServers: [{ name: "relative", transport: "stdio", command: "tool", tools: ["act"] }] } as any)).rejects.toThrow(/absolute command/u);
  });

  it("lowers declared MCP and Moltnet for an AGY agent, like every other engine", async () => {
    // Daimon used to refuse this outright ("Daimon AGY does not expose
    // cognition tools"), which is what made an AGY agent unable to take part
    // in a multi-agent organization at all.
    const agy = createDaimonNode("agy-tools", "agy-tools", "agy");
    const node = {
      ...agy,
      mcpServers: [{ name: "tool", transport: "stdio", command: "/bin/tool", tools: ["act"], args: [], env: {} }],
      surfaces: { moltnet: [{ network: "news", rooms: { lobby: {} } }] }
    } as any;
    const compiled = await daimonAdapter.compileAgent(node);
    expect(compiled.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "mcp.tool", outcome: "supported" }),
      expect.objectContaining({ key: "surfaces.moltnet", outcome: "supported" })
    ]));
    const target = (await daimonAdapter.createContainerTargets!([
      { emittedFiles: [], id: "agent:agy", kind: "agent", slug: "agy", value: node }
    ]))[0]!;
    const config = JSON.parse(target.files.find((file) => file.path === "daimon-organization-runtime.json")!.content);
    expect(config.agents[0].engine).toEqual({ kind: "agy" });
    expect(config.agents[0].mcp).toEqual([
      { name: "tool", transport: "stdio", args: [], env: {}, tools: ["act"], command: "/bin/tool" }
    ]);
    expect(config.agents[0].moltnet.networks).toEqual([{ id: "news", rooms: ["lobby"], dms: false }]);
  });

  it("keeps the AGY subscription realm and the usage ledger attached across deployments", async () => {
    // Without `exclusive-reattach` the volume name folds in the run id
    // (`createPersistentVolumeName`), so every `spawnfile up` hands the
    // container an empty keyring and the operator has to redo the interactive
    // OAuth enrolment. The usage ledger has to survive for the same reason:
    // a run-scoped ledger makes cross-deployment accounting impossible, and an
    // AGY-only organization needs it just as much as a Grok one.
    const target = (await daimonAdapter.createContainerTargets!([
      { emittedFiles: [], id: "agent:agy", kind: "agent", slug: "agy", value: createDaimonNode("agy", "AGY", "agy") }
    ]))[0]!;
    expect(target.persistentMounts).toContainEqual({
      id: "daimon-agy-subscription-realm",
      lifecycle: "exclusive-reattach",
      mountPath: "/var/lib/spawnfile/daimon/agy-subscription-realm",
      reason: "Daimon host AGY subscription realm"
    });
    expect(target.persistentMounts).toContainEqual({
      id: "daimon-grok-usage-ledger",
      lifecycle: "exclusive-reattach",
      mountPath: "/var/lib/spawnfile/daimon/usage",
      reason: "Daimon per-turn engine usage ledger"
    });
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

  /**
   * `restrict_to_workspace` is on this adapter's runtime-option allowlist and is
   * read by nothing under `src/runtime/daimon/`. PicoClaw lowers an identically
   * named option for real, which is what makes it look wired here. An author
   * who declares it gets no error and none of the confinement they asked for,
   * so the compile has to say so out loud.
   */
  it("warns that a declared restrict_to_workspace is not enforced by the Daimon runtime", async () => {
    const node = createDaimonNode("confined", "Confined");
    node.runtime.options.restrict_to_workspace = true;

    const compiled = await daimonAdapter.compileAgent(node);

    const messages = compiled.diagnostics.map((diagnostic) => diagnostic.message);
    expect(messages).toContainEqual(
      expect.stringContaining("Daimon organization runtime v1 does not enforce restrict_to_workspace")
    );
    const warning = messages.find((message) => message.includes("does not enforce restrict_to_workspace"))!;
    // The diagnostic has to name the agent, the actual behavior, and the way out.
    expect(warning).toContain("Confined");
    expect(warning).toContain("can reach the whole container filesystem");
    expect(warning).toContain("picoclaw");
    // Warn, never reject: a project already declaring the option must keep compiling.
    expect(compiled.diagnostics.every((diagnostic) => diagnostic.level !== "error")).toBe(true);
    expect(daimonAdapter.validateRuntimeOptions?.({ engine: "codex", restrict_to_workspace: true })).toEqual([]);
  });

  it("stays silent about restrict_to_workspace when it is absent or explicitly false", async () => {
    const undeclared = await daimonAdapter.compileAgent(createDaimonNode("plain", "Plain"));
    const optedOut = createDaimonNode("open", "Open");
    optedOut.runtime.options.restrict_to_workspace = false;

    const compiled = await daimonAdapter.compileAgent(optedOut);

    for (const result of [undeclared, compiled]) {
      expect(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"))
        .not.toContain("does not enforce restrict_to_workspace");
    }
  });
});
