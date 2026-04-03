import { describe, expect, it } from "vitest";

import {
  getAgentFingerprint,
  getMcpNames,
  getTeamFingerprint,
  validateEffectiveSkillRequirements
} from "./compilePlanHelpers.js";

describe("compilePlanHelpers", () => {
  it("collects MCP server names", () => {
    expect(
      [...getMcpNames([{ name: "search" }, { name: "filesystem" }, { name: "search" }])]
    ).toEqual(["search", "filesystem"]);
  });

  it("validates skill MCP requirements", () => {
    expect(() =>
      validateEffectiveSkillRequirements(
        "researcher",
        new Set(["search", "filesystem"]),
        [
          {
            content: "",
            name: "research",
            ref: "./skills/research",
            requiresMcp: ["search"],
            sourcePath: "/tmp/skills/research/SKILL.md"
          }
        ]
      )
    ).not.toThrow();

    expect(() =>
      validateEffectiveSkillRequirements(
        "researcher",
        new Set(["filesystem"]),
        [
          {
            content: "",
            name: "research",
            ref: "./skills/research",
            requiresMcp: ["search"],
            sourcePath: "/tmp/skills/research/SKILL.md"
          }
        ]
      )
    ).toThrow(/requires undeclared MCP server: search/);
  });

  it("includes surfaces and networks in fingerprints", () => {
    const baseAgent = {
      description: "",
      docs: [],
      env: {},
      execution: undefined,
      kind: "agent" as const,
      mcpServers: [],
      name: "researcher",
      policyMode: null,
      policyOnDegrade: null,
      runtime: { name: "openclaw" as const, options: {} },
      secrets: [],
      skills: [],
      source: "/tmp/agents/researcher/Spawnfile",
      subagents: []
    };

    expect(
      getAgentFingerprint({
        ...baseAgent,
        surfaces: {
          moltnet: [{ memberId: "researcher", network: "local_lab", teamSource: "/tmp/team/Spawnfile" }]
        }
      })
    ).not.toBe(
      getAgentFingerprint({
        ...baseAgent,
        surfaces: undefined
      })
    );

    const baseTeam = {
      auth: null,
      description: "",
      docs: [],
      external: ["researcher"],
      kind: "team" as const,
      lead: "researcher",
      members: [],
      mode: "hierarchical" as const,
      name: "research-cell",
      policyMode: null,
      policyOnDegrade: null,
      shared: {
        env: {},
        mcpServers: [],
        secrets: [],
        skills: []
      },
      source: "/tmp/team/Spawnfile"
    };

    expect(
      getTeamFingerprint({
        ...baseTeam,
        networks: [
          {
            id: "local_lab",
            name: "Local Lab",
            provider: "moltnet",
            rooms: [{ id: "research", members: ["researcher"] }]
          }
        ]
      })
    ).not.toBe(
      getTeamFingerprint({
        ...baseTeam,
        networks: []
      })
    );
  });
});
