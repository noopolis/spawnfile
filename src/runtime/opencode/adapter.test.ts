import { describe, expect, it } from "vitest";

import type { ResolvedAgentNode } from "../../compiler/types.js";
import { adapter } from "./registration.js";

function agent(overrides: Partial<ResolvedAgentNode> = {}): ResolvedAgentNode {
  return {
    kind: "agent", name: "Pilot", source: "pilot", description: "", env: {}, policyMode: null, policyOnDegrade: null,
    runtime: { name: "opencode", options: {} }, docs: [], skills: [], secrets: [], mcpServers: [], subagents: [],
    execution: undefined, ...overrides
  };
}

async function config(node: ResolvedAgentNode) {
  const { files } = await adapter.compileAgent(node);
  return JSON.parse(files.find(file => file.path === "opencode.json")!.content);
}

describe("OpenCode adapter", () => {
  it("selects catalog models and the declared provider credential", async () => {
    const node = agent({ execution: { model: {
      primary: { provider: "openai", name: "gpt-5", auth: { method: "api_key", key: "PILOT_KEY" } }
    } } });
    expect(await config(node)).toMatchObject({
      model: "openai/gpt-5", enabled_providers: ["openai"], provider: { openai: { env: ["PILOT_KEY"] } },
      autoupdate: false, share: "disabled"
    });
  });

  it("writes documents and native skill discovery paths", async () => {
    const node = agent({
      docs: [
        { role: "system", content: "System.", sourcePath: "system.md" },
        { role: "soul", content: "Soul.", sourcePath: "soul.md" }
      ],
      skills: [{ name: "reference", ref: "skill", content: "Skill.", requiresMcp: [], sourcePath: "skill/SKILL.md" }]
    });
    const result = await adapter.compileAgent(node);
    expect(result.files).toEqual(expect.arrayContaining([
      { path: "workspace/AGENTS.md", content: "System." },
      { path: "workspace/SOUL.md", content: "Soul." },
      { path: "workspace/skills/reference/SKILL.md", content: "Skill." }
    ]));
    expect(await config(node)).toMatchObject({
      instructions: ["<workspace-path>/AGENTS.md", "<workspace-path>/SOUL.md"],
      skills: { paths: ["<workspace-path>/skills", "<workspace-path>/.agents/skills"] }
    });
    expect(adapter.systemInstructionSurface?.resolvePath({ node })).toBe("workspace/AGENTS.md");
  });

  it("lowers anonymous OpenAI-compatible and keyed Anthropic-compatible endpoints", async () => {
    const base_url = "http://127.0.0.1:9100/v1";
    const local = agent({ execution: { model: {
      primary: { provider: "local", name: "pilot", endpoint: { compatibility: "openai", base_url } }
    } } });
    expect(await config(local)).toMatchObject({
      model: "local/pilot", small_model: "local/pilot", provider: { local: {
        npm: "@ai-sdk/openai-compatible", env: [], options: { baseURL: base_url }, models: { pilot: { tool_call: true } }
      } }
    });
    const custom = agent({ execution: { model: {
      primary: { provider: "custom", name: "pilot", endpoint: { compatibility: "anthropic", base_url },
        auth: { method: "api_key", key: "CUSTOM_KEY" } }
    } } });
    expect(await config(custom)).toMatchObject({
      model: "custom/pilot", provider: { custom: { npm: "@ai-sdk/anthropic", env: ["CUSTOM_KEY"] } }
    });
  });

  it("uses the pinned npm install path and scopes ACP and serve to each agent", async () => {
    const recipe = await adapter.install.createRecipe({
      runtimeName: "opencode", installRoot: "/runtime", containerEnv: {}, selection: {
        ecosystem: "node", installHint: "Install the pinned npm runtime package.", kind: "npm",
        packageName: "opencode-ai", runtimeName: "opencode", runtimeRef: "v1.19.6",
        selectionSource: "runtime_registry_install", version: "1.19.6"
      }
    });
    expect(recipe.commands).toEqual([
      "npm install -g --prefix /usr/local --omit=dev --no-fund --no-audit opencode-ai@1.19.6",
      "node /usr/local/lib/node_modules/opencode-ai/postinstall.mjs"
    ]);
    expect(adapter.container.startCommand.slice(-5)).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "<port>"]);
    expect(adapter.wiring?.readiness?.path).toBe("/global/health");
    const wiring = adapter.wiring!.moltnet!;
    expect(wiring.workspace).toMatchObject({ cliRuntime: "generic", skillPaths: ["workspace/.agents/skills/moltnet/SKILL.md"] });
    expect(wiring.releaseCapability).toBe("acp-bridge");
    for (const id of ["one", "two"]) {
      const prefix = `/instances/${id} with space`;
      const workspacePath = `${prefix}/workspace`;
      const bridge = wiring.bridge({ configPath: `${prefix}/opencode.json`, homePath: `${prefix}/home`, workspacePath,
        agentId: id, agentName: id, memberId: id, networkId: "network", networkStateDirectory: "/net", nodeSlug: id });
      expect(bridge).toMatchObject({ kind: "acp", command: "/usr/bin/env", workspace_path: workspacePath });
      expect(bridge.args).toEqual(expect.arrayContaining([
        workspacePath, `HOME=${prefix}/home`, `XDG_DATA_HOME=${prefix}/home/.local/share`,
        `XDG_CONFIG_HOME=${prefix}/home/.config`, `OPENCODE_CONFIG=${prefix}/opencode.json`
      ]));
      expect((bridge.args as string[]).slice(-7)).toEqual(["acp", "--hostname", "127.0.0.1", "--port", "0", "--cwd", workspacePath]);
    }
  });

  it("reports unavailable features and refuses unsupported route selections", async () => {
    expect(adapter.validateRuntimeOptions?.({ restrict_to_workspace: true })?.[0]).toMatchObject({ level: "error" });
    expect(() => adapter.assertSupportedSurfaces?.({ webhook: { url: "http://localhost" } })).toThrow(/webhook/);
    expect(() => adapter.assertSupportedModelTarget({ provider: "openai", name: "gpt-5", auth: { method: "codex" } }))
      .toThrow(/codex auth/);
    expect(() => adapter.assertSupportedModelTarget({
      provider: "openai", name: "gpt-5", auth: { method: "api_key" }, reasoningEffort: "high"
    })).toThrow(/reasoning_effort/);
    const model = { provider: "openai", name: "gpt-5" };
    await expect(adapter.compileAgent(agent({ execution: { model: { primary: model, fallback: [model] } } })))
      .rejects.toThrow(/fallback/);
    await expect(adapter.compileAgent(agent({ expose: true }))).rejects.toThrow(/loopback/);
    const result = await adapter.compileAgent(agent({
      schedule: { kind: "every", every: "1m" }, subagents: [{ id: "worker", nodeSource: "worker" }],
      execution: { sandbox: { mode: "sandboxed" } }
    }));
    expect(result.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "agent.schedule", outcome: "degraded" }),
      expect.objectContaining({ key: "agent.subagents", outcome: "degraded" }),
      expect.objectContaining({ key: "execution.sandbox", outcome: "degraded" })
    ]));
  });

  it("lowers native MCP with ordered argv and materializes bearer credentials by exact key", async () => {
    const node = agent({ mcpServers: [
      { name: "local", transport: "stdio", command: "node", args: ["test file.mjs"], env: { FLAG: "set" } },
      { name: "remote.test", transport: "streamable_http", url: "http://internal/mcp", auth: { mode: "bearer", secret: "TOKEN" } }
    ] });
    const { files } = await adapter.compileAgent(node);
    const [target] = await adapter.createContainerTargets!([{ id: "pilot", kind: "agent", slug: "pilot", value: node, emittedFiles: files }]);
    expect(await config(node)).toMatchObject({ mcp: {
      local: { type: "local", command: ["node", "test file.mjs"], environment: { FLAG: "set" } },
      "remote.test": { type: "remote", url: "http://internal/mcp", oauth: false }
    } });
    expect(target?.configEnvBindings).toEqual([
      { envName: "TOKEN", jsonPath: ["mcp", "remote.test", "headers", "Authorization"], transform: "bearer" }
    ]);
    const narrowed = agent({ mcpServers: [{ ...node.mcpServers[0]!, tools: ["read"] }] });
    await expect(adapter.compileAgent(narrowed)).rejects.toThrow(/allowlist/);
  });
});
