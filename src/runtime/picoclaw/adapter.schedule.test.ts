import { describe, expect, it } from "vitest";

import type { ResolvedAgentNode } from "../../compiler/types.js";

import { picoClawAdapter } from "./adapter.js";

const node: ResolvedAgentNode = {
  description: "",
  docs: [],
  env: {},
  execution: {
    model: {
      primary: {
        name: "gpt-4o-mini",
        provider: "openai"
      }
    }
  },
  kind: "agent",
  mcpServers: [],
  name: "assistant",
  policyMode: null,
  policyOnDegrade: null,
  runtime: { name: "picoclaw", options: {} },
  secrets: [],
  skills: [],
  source: "/tmp/Spawnfile",
  subagents: []
};

describe("picoClawAdapter schedules", () => {
  it("enables PicoClaw's cron tool for cron schedules", async () => {
    const result = await picoClawAdapter.compileAgent({
      ...node,
      schedule: {
        cron: "* * * * *",
        kind: "cron",
        prompt: "drain the backlog"
      }
    });

    expect(
      JSON.parse(result.files.find((file) => file.path === "config.json")?.content ?? "{}")
    ).toMatchObject({
      tools: {
        cron: {
          enabled: true
        }
      }
    });
  });
});
