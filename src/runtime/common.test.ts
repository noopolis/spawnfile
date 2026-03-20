import { describe, expect, it } from "vitest";

import { ResolvedAgentNode } from "../compiler/types.js";

import { createAgentCapabilities, createDocumentFiles, createSkillFiles } from "./common.js";

const baseAgent: ResolvedAgentNode = {
  docs: [
    { content: "# System", role: "system", sourcePath: "/tmp/AGENTS.md" },
    { content: "# Extra", role: "extras.notes", sourcePath: "/tmp/NOTES.md" }
  ],
  env: {},
  execution: {
    model: {
      primary: {
        name: "claude-sonnet-4-5",
        provider: "anthropic"
      }
    },
    sandbox: { mode: "workspace" },
    workspace: { isolation: "isolated" }
  },
  kind: "agent",
  mcpServers: [{ name: "web_search", transport: "streamable_http", url: "https://example.com" }],
  name: "assistant",
  policyMode: null,
  policyOnDegrade: null,
  runtime: { name: "openclaw", options: {} },
  secrets: [],
  skills: [
    {
      content: "---\nname: web_search\ndescription: Search\n---\n",
      name: "web_search",
      ref: "./skills/web_search",
      requiresMcp: ["web_search"],
      sourcePath: "/tmp/SKILL.md"
    }
  ],
  source: "/tmp/Spawnfile",
  subagents: [{ id: "critic", nodeSource: "/tmp/subagent/Spawnfile" }]
};

describe("runtime common helpers", () => {
  it("maps built-in and extra documents to files", () => {
    expect(createDocumentFiles("workspace", baseAgent.docs)).toEqual([
      { content: "# System", path: "workspace/AGENTS.md" },
      { content: "# Extra", path: "workspace/extras/notes.md" }
    ]);
  });

  it("maps skills to emitted skill files", () => {
    expect(createSkillFiles("workspace/skills", baseAgent.skills)).toEqual([
      {
        content: "---\nname: web_search\ndescription: Search\n---\n",
        path: "workspace/skills/web_search/SKILL.md"
      }
    ]);
  });

  it("creates capability entries for docs, skills, mcp, execution, and subagents", () => {
    const capabilities = createAgentCapabilities(baseAgent, {
      mcpOutcome: "degraded",
      sandboxOutcome: "supported",
      subagentOutcome: "degraded",
      workspaceOutcome: "supported"
    });

    expect(capabilities.map((capability) => capability.key)).toEqual([
      "docs.system",
      "docs.extras.notes",
      "skills.web_search",
      "mcp.web_search",
      "execution.model",
      "execution.workspace",
      "execution.sandbox",
      "agent.subagents"
    ]);
    expect(capabilities.find((capability) => capability.key === "mcp.web_search")?.outcome).toBe(
      "degraded"
    );
  });
});
