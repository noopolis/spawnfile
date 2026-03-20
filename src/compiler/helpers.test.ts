import { describe, expect, it } from "vitest";

import { assignStableNodeIds, slugify, stableStringify } from "./helpers.js";

describe("compiler helpers", () => {
  it("slugifies names", () => {
    expect(slugify("Research Cell")).toBe("research-cell");
  });

  it("stringifies objects stably", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("adds path hashes on node id collisions", () => {
    const nodes = assignStableNodeIds([
      {
        kind: "agent" as const,
        runtimeName: "openclaw",
        source: "/tmp/a/Spawnfile",
        slug: "",
        value: {
          docs: [],
          env: {},
          execution: undefined,
          kind: "agent" as const,
          mcpServers: [],
          name: "assistant",
          policyMode: null,
          policyOnDegrade: null,
          runtime: { name: "openclaw", options: {} },
          secrets: [],
          skills: [],
          source: "/tmp/a/Spawnfile",
          subagents: []
        }
      },
      {
        kind: "agent" as const,
        runtimeName: "openclaw",
        source: "/tmp/b/Spawnfile",
        slug: "",
        value: {
          docs: [],
          env: {},
          execution: undefined,
          kind: "agent" as const,
          mcpServers: [],
          name: "assistant",
          policyMode: null,
          policyOnDegrade: null,
          runtime: { name: "openclaw", options: {} },
          secrets: [],
          skills: [],
          source: "/tmp/b/Spawnfile",
          subagents: []
        }
      }
    ]);

    expect(nodes[0].id).toBe("agent:assistant");
    expect(nodes[1].id).toMatch(/^agent:assistant#/);
  });
});
