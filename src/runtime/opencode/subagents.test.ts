import { describe, expect, it } from "vitest";

import type { ResolvedAgentNode } from "../../compiler/types.js";
import type { RuntimeCompileContext } from "../types.js";
import { buildOpenCodeSubagents } from "./subagents.js";

function agent(overrides: Partial<ResolvedAgentNode> = {}): ResolvedAgentNode {
  return {
    kind: "agent", name: "Pilot", source: "pilot", description: "", env: {}, policyMode: null, policyOnDegrade: null,
    runtime: { name: "opencode", options: {} }, docs: [], skills: [], secrets: [], mcpServers: [], subagents: [],
    execution: { model: { primary: {
      provider: "local", name: "fixture", endpoint: { base_url: "http://127.0.0.1:1", compatibility: "openai" }
    } } },
    ...overrides
  };
}

function fixture(childOverrides: Partial<ResolvedAgentNode> = {}) {
  const child = agent({
    name: "Reviewer", source: "reviewer", description: "Review supplied copy.",
    docs: [{ role: "soul", content: "Apply the {env:SYNTHETIC_TOKEN} rubric.", sourcePath: "soul.md" }],
    ...childOverrides
  });
  const parent = agent({ subagents: [{ id: "review", nodeSource: child.source }] });
  const context: RuntimeCompileContext = { subagents: [{ id: "review", slug: "reviewer-42", node: child }] };
  return { child, parent, context };
}

describe("OpenCode native subagents", () => {
  it("emits a named text role with a file-backed prompt and deny-by-default task config", () => {
    const { parent, context } = fixture();
    const plan = buildOpenCodeSubagents(parent, context);
    expect(plan.config).toEqual({
      agent: {
        "spawnfile-reviewer-42": {
          mode: "subagent", model: "local/fixture",
          prompt: "{file:./home/spawnfile-subagents/spawnfile-reviewer-42.md}",
          description: "{file:./home/spawnfile-subagents/spawnfile-reviewer-42.description.txt}",
          permission: { "*": "deny", external_directory: "deny", read: "deny", task: "deny" }
        }
      },
      permission: { task: "deny" },
      plugin: ["./home/spawnfile-subagents/guard.mjs"],
      subagent_depth: 1
    });
    expect(plan.files[0]?.content).toBe(
      "You are Reviewer, the declared Spawnfile helper review.\n\n" +
      "Review supplied copy.\n\nApply the {env:SYNTHETIC_TOKEN} rubric.\n"
    );
    expect(plan.message).toContain("parent's workspace");
  });

  it("omits a child requiring a separate scope and refuses ambiguous declarations", () => {
    const { parent, context } = fixture({ env: { SYNTHETIC_TOKEN: "test" } });
    const plan = buildOpenCodeSubagents(parent, context);
    expect(plan.files).toEqual([]);
    expect(plan.config).toEqual({ permission: { task: "deny" } });
    expect(plan.message).toContain("review requires capabilities");
    for (const child of context.subagents) {
      expect(() => buildOpenCodeSubagents(parent, { subagents: [{ ...child, slug: "../reviewer" }] }))
        .toThrow("Ambiguous OpenCode subagents");
      expect(() => buildOpenCodeSubagents(parent, { subagents: [child, child] }))
        .toThrow("Ambiguous OpenCode subagents");
      expect(() => buildOpenCodeSubagents(parent, { subagents: [{ ...child, id: "some-other-role" }] }))
        .toThrow("Ambiguous OpenCode subagents");
    }
    expect(buildOpenCodeSubagents(parent).config.permission).toEqual({ task: "deny" });
  });

  it("omits a child with a different model or a separately scoped native login", () => {
    const different = fixture({ execution: { model: { primary: {
      provider: "local", name: "another", endpoint: { base_url: "http://127.0.0.1:1", compatibility: "openai" }
    } } } });
    expect(buildOpenCodeSubagents(different.parent, different.context).message).toContain("identical");
    const execution = { model: { primary: {
      provider: "openai", name: "fixture", auth: { method: "codex" as const }
    } } };
    const login = fixture({ execution });
    expect(buildOpenCodeSubagents({ ...login.parent, execution }, login.context).message).toContain("native login scope");
  });

  it("uses the generated native guard to expose only plain-text, fresh declared tasks", async () => {
    const { parent, context } = fixture();
    const plan = buildOpenCodeSubagents(parent, context);
    const guard = plan.files.find(file => file.path.endsWith("/guard.mjs"))!;
    const { spawnfileSubagents } = await import(`data:text/javascript;base64,${Buffer.from(guard.content).toString("base64")}`);
    const hooks = await spawnfileSubagents();
    const compiledRole = plan.config.agent?.["spawnfile-reviewer-42"];
    const config = {
      agent: {
        build: { model: "local/fixture" },
        "spawnfile-reviewer-42": { ...compiledRole, prompt: "Reviewer role" }
      }
    };
    expect(() => hooks.config({ agent: {} })).toThrow("require compiled text-only roles");
    expect(() => hooks.config({ agent: { "spawnfile-reviewer-42": {
      ...config.agent["spawnfile-reviewer-42"], permission: { "*": "deny", read: "allow" }
    } } })).toThrow("require compiled text-only roles");
    hooks.config(config);
    expect(config.agent.build).toEqual({
      model: "local/fixture",
      permission: { task: { "*": "deny", "spawnfile-reviewer-42": "allow" } }
    });
    const beforeTask = (args: Record<string, unknown>) => hooks["tool.execute.before"]({ tool: "task" }, { args });
    const task = { subagent_type: "spawnfile-reviewer-42", prompt: "Review this text." };
    expect(() => beforeTask(task)).not.toThrow();
    expect(() => beforeTask({ ...task, prompt: "Read @/private/example" })).toThrow("plain text");
    expect(() => beforeTask({ ...task, prompt: "Ask @general" })).toThrow("plain text");
    expect(() => beforeTask({ ...task, subagent_type: "general" })).toThrow("declared");
    expect(() => beforeTask({ ...task, task_id: "session-1" })).toThrow("fresh");
    expect(() => beforeTask({ ...task, background: true })).toThrow("foreground");
    const output = { system: ["Reviewer role\nParent instructions\n<mcp_instructions>"] };
    hooks["experimental.chat.system.transform"]({}, output);
    expect(output.system).toEqual(["Reviewer role"]);
  });
});
