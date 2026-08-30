import { describe, expect, it } from "vitest";

import { ResolvedAgentNode } from "../compiler/types.js";

import {
  CLI_ENGINE_SKILL_BASE_DIRECTORIES,
  createAgentCapabilities,
  createDocumentFiles,
  createSkillFiles,
  ensureNoopolisRunId,
  NOOPOLIS_RUN_ID_ENV,
  resolveNoopolisRunId
} from "./common.js";

const baseAgent: ResolvedAgentNode = {
  description: "",
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
    sandbox: { mode: "workspace" }
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

  it("fans one skill out across every requested discovery root", () => {
    expect(createSkillFiles(["workspace/.agents/skills", "workspace/.codex/skills"], baseAgent.skills)).toEqual([
      {
        content: "---\nname: web_search\ndescription: Search\n---\n",
        path: "workspace/.agents/skills/web_search/SKILL.md"
      },
      {
        content: "---\nname: web_search\ndescription: Search\n---\n",
        path: "workspace/.codex/skills/web_search/SKILL.md"
      }
    ]);
  });

  it("pins the CLI-engine skill roots to the roots Moltnet installs its own skill into", () => {
    // resolveMoltnetWorkspaceLayout("daimon"|"pi") installs the Moltnet skill
    // into exactly these two roots, and that skill demonstrably reaches the
    // engine in a running container. Declared skills must land in the same
    // places or no engine ever discovers them.
    expect([...CLI_ENGINE_SKILL_BASE_DIRECTORIES]).toEqual([
      "workspace/.agents/skills",
      "workspace/.codex/skills"
    ]);
    expect(
      createSkillFiles(CLI_ENGINE_SKILL_BASE_DIRECTORIES, baseAgent.skills).map((file) => file.path)
    ).toEqual([
      "workspace/.agents/skills/web_search/SKILL.md",
      "workspace/.codex/skills/web_search/SKILL.md"
    ]);
  });

  it("creates capability entries for docs, skills, mcp, execution, and subagents", () => {
    const capabilities = createAgentCapabilities(baseAgent, {
      mcpOutcome: "degraded",
      sandboxOutcome: "supported",
      subagentOutcome: "degraded"
    });

    expect(capabilities.map((capability) => capability.key)).toEqual([
      "docs.system",
      "docs.extras.notes",
      "skills.web_search",
      "mcp.web_search",
      "execution.model",
      "execution.sandbox",
      "agent.subagents"
    ]);
    expect(capabilities.find((capability) => capability.key === "mcp.web_search")?.outcome).toBe(
      "degraded"
    );
  });

  it("creates memory capabilities for accessible memory banks", () => {
    const capabilities = createAgentCapabilities({
      ...baseAgent,
      memoryAccess: [
        {
          agentSource: "/tmp/Spawnfile",
          bank: {
            consolidation: { mode: "disabled" },
            declaredBy: "agent",
            declaredName: "assistant",
            id: "notes",
            index: {
              graph: { enabled: false },
              lexical: { enabled: true },
              rerank: { enabled: false },
              vector: { enabled: false }
            },
            retention: { forgetting: "manual" },
            source: "/tmp/Spawnfile",
            store: { kind: "sqlite", path: "/var/lib/spawnfile/memory/assistant/notes/memory.sqlite" }
          },
          declaringKind: "agent",
          source: "/tmp/Spawnfile"
        }
      ]
    }, {
      memoryMessage: "memory via tools",
      memoryOutcome: "supported"
    });

    expect(capabilities).toContainEqual({
      key: "memory",
      message: "memory via tools",
      outcome: "supported"
    });
    expect(capabilities).toContainEqual({
      key: "memory.notes",
      message: "memory via tools",
      outcome: "supported"
    });
  });

  it("marks agent schedules as degraded until a runtime scheduler is emitted", () => {
    const capabilities = createAgentCapabilities({
      ...baseAgent,
      schedule: {
        cron: "0 5 * * *",
        kind: "cron"
      }
    });

    expect(capabilities.find((capability) => capability.key === "agent.schedule")).toMatchObject({
      outcome: "degraded"
    });
  });

  it("allows adapters to override Moltnet surface capability outcomes", () => {
    const capabilities = createAgentCapabilities({
      ...baseAgent,
      surfaces: {
        moltnet: [
          {
            memberId: "assistant",
            network: "local_lab",
            rooms: {
              agora: { wake: "mentions" }
            },
            teamSource: "/tmp/Spawnfile"
          }
        ]
      }
    }, {
      moltnetMessage: "client config only",
      moltnetOutcome: "degraded"
    });

    expect(capabilities.find((capability) => capability.key === "surfaces.moltnet")).toEqual({
      key: "surfaces.moltnet",
      message: "client config only",
      outcome: "degraded"
    });
  });
});

describe("resolveNoopolisRunId", () => {
  it("exposes NOOPOLIS_RUN_ID as the env var name", () => {
    expect(NOOPOLIS_RUN_ID_ENV).toBe("NOOPOLIS_RUN_ID");
  });

  it("returns the trimmed run id when set", () => {
    expect(resolveNoopolisRunId({ NOOPOLIS_RUN_ID: "  run-123  " })).toBe("run-123");
  });

  it("returns undefined when unset", () => {
    expect(resolveNoopolisRunId({})).toBeUndefined();
  });

  it("returns undefined for a blank value", () => {
    expect(resolveNoopolisRunId({ NOOPOLIS_RUN_ID: "   " })).toBeUndefined();
  });

  it("defaults to reading from process.env", () => {
    const original = process.env.NOOPOLIS_RUN_ID;
    process.env.NOOPOLIS_RUN_ID = "run-from-process-env";
    try {
      expect(resolveNoopolisRunId()).toBe("run-from-process-env");
    } finally {
      if (original === undefined) {
        delete process.env.NOOPOLIS_RUN_ID;
      } else {
        process.env.NOOPOLIS_RUN_ID = original;
      }
    }
  });
});

describe("ensureNoopolisRunId", () => {
  it("returns the existing trimmed run id and leaves env untouched when already set", () => {
    const env: NodeJS.ProcessEnv = { NOOPOLIS_RUN_ID: "  run-existing  " };

    expect(ensureNoopolisRunId(env)).toBe("run-existing");
    expect(env.NOOPOLIS_RUN_ID).toBe("  run-existing  ");
  });

  it("generates and stamps a fresh run id onto env when unset", () => {
    const env: NodeJS.ProcessEnv = {};

    const generated = ensureNoopolisRunId(env);

    expect(generated).toMatch(/^run-[0-9a-f]{32}$/);
    expect(env.NOOPOLIS_RUN_ID).toBe(generated);
  });

  it("generates and stamps a fresh run id onto env when blank", () => {
    const env: NodeJS.ProcessEnv = { NOOPOLIS_RUN_ID: "   " };

    const generated = ensureNoopolisRunId(env);

    expect(generated).toMatch(/^run-[0-9a-f]{32}$/);
    expect(env.NOOPOLIS_RUN_ID).toBe(generated);
  });

  it("generates a different run id on each call given separate unset envs", () => {
    expect(ensureNoopolisRunId({})).not.toBe(ensureNoopolisRunId({}));
  });

  it("defaults to reading/stamping process.env", () => {
    const original = process.env.NOOPOLIS_RUN_ID;
    delete process.env.NOOPOLIS_RUN_ID;
    try {
      const generated = ensureNoopolisRunId();
      expect(process.env.NOOPOLIS_RUN_ID).toBe(generated);
    } finally {
      if (original === undefined) {
        delete process.env.NOOPOLIS_RUN_ID;
      } else {
        process.env.NOOPOLIS_RUN_ID = original;
      }
    }
  });
});
