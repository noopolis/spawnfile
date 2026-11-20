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
    expect(target.persistentMounts).toEqual([{ id: "hermes-agent-assistant-workspace", mountPath: "<instance-root>/workspace", reason: "Hermes Agent workspace" }]);
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
    expect(bridge.args?.slice(-2)).toEqual(["/opt/hermes/.venv/bin/hermes", "acp"]);
    expect(() => wiring.bridge({ ...context, homePath: "/another home" })).toThrow(/outside the native home/);
  });

  it("rejects unavailable routes and reports unsupported authored features", async () => {
    expect(() => adapter.assertSupportedSurfaces?.({ discord: {} } as never)).toThrow(/discord surface/);
    expect(adapter.validateRuntimeOptions?.({ passthrough: true })).toMatchObject([{ level: "error" }]);
    await expect(adapter.compileAgent({ ...node, expose: true })).rejects.toThrow(/public ingress/);
    await expect(adapter.compileAgent({ ...node, execution: undefined })).rejects.toThrow(/primary execution model/);
    await expect(adapter.compileAgent({
      ...node, execution: { model: { primary: { provider: "openai", name: "gpt-5", auth: { method: "codex" } } } }
    })).rejects.toThrow(/codex auth/);
    const { capabilities } = await adapter.compileAgent({
      ...node, mcpServers: [{ name: "local", transport: "stdio", command: "node" }]
    });
    expect(capabilities).toContainEqual(expect.objectContaining({ key: "mcp.local", outcome: "unsupported" }));
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
