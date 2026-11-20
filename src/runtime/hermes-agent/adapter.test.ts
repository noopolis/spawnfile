import { describe, expect, it } from "vitest";

import type { ResolvedAgentNode } from "../../compiler/types.js";
import type { RuntimeInstallSelection } from "../install.js";
import { hermesDigest, hermesImage, hermesImageRef, hermesTag } from "./install.js";
import { hermesAgentAdapter } from "./adapter.js";
import { adapter } from "./registration.js";

const node: ResolvedAgentNode = {
  description: "", name: "assistant", kind: "agent", source: "/tmp/Spawnfile", env: {},
  docs: [
    { role: "system", sourcePath: "/tmp/AGENTS.md", content: "System instructions" },
    { role: "soul", sourcePath: "/tmp/SOUL.md", content: "Persona instructions" }
  ],
  skills: [{ name: "pilot", ref: "./pilot", sourcePath: "/tmp/pilot/SKILL.md", content: "Skill", requiresMcp: [] }],
  execution: { model: { primary: {
    provider: "local", name: "deterministic", endpoint: { base_url: "http://127.0.0.1:18191/v1", compatibility: "openai" }
  } } },
  mcpServers: [], secrets: [], subagents: [],
  policyMode: null, policyOnDegrade: null, runtime: { name: "hermes-agent", options: {} }
};

const targetFor = async (value: ResolvedAgentNode) => {
  const { files } = await adapter.compileAgent(value);
  const [target] = await adapter.createContainerTargets!([{ value, kind: "agent", id: "node", slug: "assistant", emittedFiles: files }]);
  return target!;
};

describe("Hermes Agent adapter", () => {
  it("registers the adapter, service and directly compiled training capability", () => {
    expect(adapter).toBe(hermesAgentAdapter);
    expect(adapter.training?.adapterId).toBe(adapter.name);
    expect(adapter.training?.run).toBeTypeOf("function");
    expect(adapter.container.startCommand).toContain("hermes-session-home");
    expect(adapter.container.startCommand.slice(-4)).toEqual(["gateway", "run", "--no-supervise", "--external-supervisor"]);
    expect(adapter.container.port).toBeUndefined();
  });

  it("emits native discovery paths, exact local model and durable workspace", async () => {
    const target = await targetFor(node);
    const files = Object.fromEntries(target.files.map(file => [file.path, file.content]));
    expect(files).toMatchObject({
      "workspace/AGENTS.md": "System instructions",
      "workspace/SOUL.md": "Persona instructions",
      "home/SOUL.md": "Persona instructions",
      "workspace/skills/pilot/SKILL.md": "Skill"
    });
    expect(adapter.systemInstructionSurface?.resolvePath({ node })).toBe("workspace/AGENTS.md");
    expect(adapter.container.instancePaths).toEqual({
      configPathTemplate: "<instance-root>/hermes/<config-file>",
      homePathTemplate: "<instance-root>/hermes",
      workspacePathTemplate: "<instance-root>/workspace"
    });
    expect(JSON.parse(files["config.yaml"]!)).toMatchObject({
      model: { default: "deterministic", provider: "custom:spawnfile-model" },
      providers: { "spawnfile-model": { base_url: "http://127.0.0.1:18191/v1", transport: "chat_completions" } },
      skills: { external_dirs: ["<workspace-path>/skills", "<workspace-path>/.agents/skills"] },
      terminal: { cwd: "<workspace-path>" },
      approvals: { mode: "manual", unattended_mode: "deny", cron_mode: "deny" }
    });
    expect(target.configEnvBindings).toBeUndefined();
    expect(target.persistentMounts).toEqual([
      { id: "hermes-agent-assistant-cron", mountPath: "<instance-root>/hermes/cron", reason: "Hermes Agent native cron state" },
      { id: "hermes-agent-assistant-sessions", lifecycle: "exclusive-reattach",
        mountPath: "<instance-root>/hermes/.spawnfile-session-store", reason: "Hermes Agent native sessions and transcript recovery" },
      { id: "hermes-agent-assistant-workspace", mountPath: "<instance-root>/workspace", reason: "Hermes Agent workspace" }
    ]);
  });

  it("binds only the selected endpoint credential at startup", async () => {
    const target = await targetFor({
      ...node,
      execution: { model: { primary: {
        provider: "custom", name: "model",
        endpoint: { base_url: "https://model.example.test", compatibility: "anthropic" },
        auth: { method: "api_key", key: "EXAMPLE_MODEL_KEY" }
      } } }
    });
    const config = JSON.parse(target.files.find(file => file.path === "config.yaml")!.content);
    expect(config.providers["spawnfile-model"]).toEqual({
      base_url: "https://model.example.test", transport: "anthropic_messages", default_model: "model"
    });
    expect(target.configEnvBindings).toEqual([{ envName: "EXAMPLE_MODEL_KEY", jsonPath: ["providers", "spawnfile-model", "api_key"] }]);
  });

  it("wires native ACP with per-instance paths and the native generic Moltnet skill location", () => {
    const wiring = adapter.wiring?.moltnet!;
    const context = { agentId: "node", agentName: "assistant", configPath: "/one home/config.yaml", homePath: "/one home",
      memberId: "member", nodeSlug: "slug", networkId: "network", networkStateDirectory: "/network", workspacePath: "/workspace one" };
    expect(wiring.releaseCapability).toBe("acp-bridge");
    expect(wiring.actorTokenScopes).toEqual(["attach", "observe", "write"]);
    expect(wiring.workspace.skillPaths).toEqual(["workspace/.agents/skills/moltnet/SKILL.md"]);
    const bridge = wiring.bridge(context);
    expect(bridge).toMatchObject({ kind: "acp", command: "env", workspace_path: context.workspacePath });
    expect(bridge.args).toEqual(expect.arrayContaining([
      "HOME=/one home", "HERMES_HOME=/one home", "HERMES_WRITE_SAFE_ROOT=/workspace one", "XDG_RUNTIME_DIR=/one home"
    ]));
    expect(bridge.args).toContain("hermes-session-home");
    expect(bridge.args?.slice(-2)).toEqual(["/opt/hermes/.venv/bin/hermes", "acp"]);
    expect(() => wiring.bridge({ ...context, homePath: "/another home" })).toThrow(/outside the native home/);
  });

  it("rejects unavailable routes and reports native MCP support", async () => {
    expect(() => adapter.assertSupportedSurfaces?.({ discord: {} } as never)).toThrow(/discord surface/);
    expect(adapter.validateRuntimeOptions?.({ passthrough: true })).toMatchObject([{ level: "error" }]);
    await expect(adapter.compileAgent({ ...node, expose: true })).rejects.toThrow(/public ingress/);
    await expect(adapter.compileAgent({ ...node, execution: undefined })).rejects.toThrow(/primary execution model/);
    await expect(adapter.compileAgent({
      ...node, execution: { model: { primary: { provider: "anthropic", name: "gpt-5", auth: { method: "codex" } } } }
    })).rejects.toThrow(/codex auth/);
    const { capabilities } = await adapter.compileAgent({
      ...node, mcpServers: [{ name: "local", transport: "stdio", command: "node" }]
    });
    expect(capabilities).toContainEqual(expect.objectContaining({ key: "mcp.local", outcome: "supported" }));
  });

  it("pins subscription routes and projects exact reasoning by model", async () => {
    for (const [provider, method, nativeProvider] of [
      ["openai", "codex", "openai-codex"], ["xai", "grok", "xai-oauth"]
    ] as const) {
      const target = await targetFor({
        ...node,
        execution: { model: { primary: { provider, name: "native-model", auth: { method }, reasoning_effort: "high" } } }
      });
      expect(JSON.parse(target.files.find(file => file.path === "config.yaml")!.content)).toMatchObject({
        model: { default: "native-model", provider: nativeProvider },
        agent: { reasoning_overrides: { "native-model": "high" } },
        auth: { adopt_external_logins: false }
      });
      expect(target.configEnvBindings).toBeUndefined();
    }
  });

  it("binds an ordered fallback to its own route and key", async () => {
    const target = await targetFor({
      ...node,
      execution: { model: {
        primary: { provider: "openai", name: "gpt-5.6", auth: { method: "codex" }, reasoning_effort: "max" },
        fallback: [
          { provider: "anthropic", name: "claude", auth: { method: "api_key", key: "CHOSEN_KEY" } },
          { provider: "openai", name: "gpt-5.4-codex", auth: { method: "codex" }, reasoning_effort: "none" }
        ]
      } }
    });
    expect(JSON.parse(target.files[0]!.content)).toMatchObject({
      model: { default: "gpt-5.6", provider: "openai-codex" },
      agent: { reasoning_overrides: { "gpt-5.6": "max", "gpt-5.4-codex": "none" } },
      fallback_providers: [
        { model: "claude", provider: "custom:spawnfile-model-1", transport: "anthropic_messages" },
        { model: "gpt-5.4-codex", provider: "openai-codex", transport: "codex_responses" }
      ]
    });
    expect(target.configEnvBindings).toEqual([{ envName: "CHOSEN_KEY", jsonPath: ["providers", "spawnfile-model-1", "api_key"] }]);
  });

  it.each([
    ["gpt-5.4-codex", "max"], ["gpt-6-astra", "none"], ["gpt-5.6", "minimal"],
    ["gpt-5.6", "ultra"], ["gpt-5.6", "persistent"]
  ] as const)("refuses %s effort %s that Hermes cannot send exactly", async (name, reasoning_effort) => {
    await expect(targetFor({
      ...node,
      execution: { model: { primary: { provider: "openai", name, auth: { method: "codex" }, reasoning_effort } } }
    })).rejects.toThrow(/reasoning_effort/);
  });

  it("rejects Claude subscription auth and subscription endpoint overrides", async () => {
    await expect(targetFor({
      ...node, execution: { model: { primary: { provider: "anthropic", name: "claude", auth: { method: "claude-code" } } } }
    })).rejects.toThrow(/claude-code auth/);
    await expect(targetFor({
      ...node,
      execution: { model: { primary: { ...node.execution!.model!.primary!, auth: { method: "codex" } } } }
    })).rejects.toThrow(/codex auth/);
  });

  it("requires the verified release image and its immutable multiarch index", async () => {
    const selection: RuntimeInstallSelection = {
      kind: "container_image", ecosystem: "node", image: hermesImage, digest: hermesDigest, tag: hermesTag,
      runtimeRef: hermesTag, runtimeName: adapter.name, selectionSource: "runtime_registry_install", installHint: ""
    };
    const input = { containerEnv: {}, installRoot: "/runtime", runtimeName: adapter.name, selection };
    const recipe = await adapter.install.createRecipe(input);
    expect(recipe).toMatchObject({ requiredBaseImage: hermesImageRef, runtimeRoot: "/opt/hermes" });
    expect(recipe.commands.join("\n")).toContain("caafe5389ae585ef77387a962aee05b1bcf17029");
    expect(() => adapter.install.createRecipe({ ...input, selection: { ...selection, image: "attacker.invalid/hermes" } }))
      .toThrow(/requires the verified/);
  });
});
