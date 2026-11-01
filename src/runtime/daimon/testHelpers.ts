import type { ResolvedAgentNode } from "../../compiler/types.js";

export const createDaimonTestNode = (
  overrides: Partial<ResolvedAgentNode> = {}
): ResolvedAgentNode => ({
  description: "Daimon test agent",
  docs: [
    {
      content: "# Instructions\n",
      role: "system",
      sourcePath: "/tmp/AGENTS.md"
    }
  ],
  env: {},
  execution: {
    model: {
      primary: {
        auth: { method: "codex" },
        name: "gpt-5.4-mini",
        provider: "openai"
      }
    },
    sandbox: { mode: "workspace" }
  },
  kind: "agent",
  mcpServers: [],
  name: "assistant",
  policyMode: null,
  policyOnDegrade: null,
  runtime: { name: "daimon", options: {} },
  secrets: [],
  skills: [
    {
      content: "---\nname: note\ndescription: Note\n---\n\nCreate notes.\n",
      name: "note",
      ref: "./skills/note",
      requiresMcp: [],
      sourcePath: "/tmp/skills/note/SKILL.md"
    }
  ],
  source: "/tmp/agent/Spawnfile",
  subagents: [],
  ...overrides
});
