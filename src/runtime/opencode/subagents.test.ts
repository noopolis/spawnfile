import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileProject } from "../../compiler/compileProject.js";
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
  it("compiles the guard and text role when execution uses the default workspace mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "spawnfile-opencode-subagent-"));
    const model = `
runtime: opencode
execution:
  model:
    primary:
      provider: local
      name: fixture
      endpoint:
        base_url: http://127.0.0.1:1
        compatibility: openai
`;
    try {
      const child = join(root, "reviewer");
      await mkdir(child);
      await Promise.all([
        writeFile(join(root, "Spawnfile"), `spawnfile_version: "0.1"
kind: agent
name: editor
${model}
subagents:
  - id: review
    ref: ./reviewer
policy:
  mode: warn
  on_degrade: warn
`),
        writeFile(join(child, "Spawnfile"), `spawnfile_version: "0.1"
kind: agent
name: reviewer
description: Review supplied copy.
${model}
workspace:
  docs:
    system: AGENTS.md
`),
        writeFile(join(child, "AGENTS.md"), "Check the copy against {env:FIXTURE_ROLE_TOKEN}.\n")
      ]);
      const result = await compileProject(root);
      const editor = join(result.outputDirectory, "container/rootfs/var/lib/spawnfile/instances/opencode/agent-editor");
      const config = JSON.parse(await readFile(join(editor, "opencode.json"), "utf8"));
      expect(config.agent["spawnfile-reviewer"]).toMatchObject({ mode: "subagent", permission: { "*": "deny" } });
      expect(config.plugin).toEqual(["./home/spawnfile-subagents/guard.mjs"]);
      expect(await readFile(join(editor, config.plugin[0]), "utf8")).toContain('["spawnfile-reviewer"]');
      expect(await readFile(join(editor, "home/.config/opencode/.npmrc"), "utf8")).toBe("offline=true\n");
      const childConfig = join(editor, "../agent-reviewer/home/.config/opencode/.npmrc");
      await expect(readFile(childConfig, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(editor, "home/spawnfile-subagents/spawnfile-reviewer.md"), "utf8"))
        .toContain("Check the copy against {env:FIXTURE_ROLE_TOKEN}.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
    for (const mode of ["sandboxed", "unrestricted"] as const) {
      const child = { ...context.subagents[0]!.node, env: {}, execution: { ...parent.execution, sandbox: { mode } } };
      expect(buildOpenCodeSubagents(parent, { subagents: [{ ...context.subagents[0]!, node: child }] }).files).toEqual([]);
    }
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
