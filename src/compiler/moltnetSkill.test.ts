import { describe, expect, it } from "vitest";

import { createMoltnetSkillFiles } from "./moltnetSkill.js";
import type { MoltnetArtifacts } from "./moltnetArtifacts.js";
import type { ResolvedAgentNode } from "./types.js";

const createArtifacts = (): MoltnetArtifacts => ({
  bridgePlans: [],
  files: [],
  ports: [8787],
  serverPlans: [
    {
      id: "research-cell-local_lab",
      name: "Local Lab",
      networkId: "local_lab",
      port: 8787,
      rooms: [{ id: "research", members: ["orchestrator"] }],
      teamSource: "/tmp/team/Spawnfile"
    }
  ]
});

const createAgent = (runtime: "openclaw" | "picoclaw" | "tinyclaw"): ResolvedAgentNode => ({
  description: "",
  docs: [],
  env: {},
  execution: undefined,
  kind: "agent",
  mcpServers: [],
  name: "orchestrator",
  policyMode: null,
  policyOnDegrade: null,
  runtime: { name: runtime, options: {} },
  secrets: [],
  skills: [],
  source: "/tmp/agents/orchestrator/Spawnfile",
  surfaces: {
    moltnet: [
      {
        dms: {
          enabled: true,
          read: "all",
          reply: "manual"
        },
        memberId: "orchestrator",
        network: "local_lab",
        rooms: {
          research: {
            read: "all",
            reply: "auto"
          }
        },
        teamSource: "/tmp/team/Spawnfile"
      }
    ]
  },
  subagents: []
});

describe("moltnetSkill", () => {
  it("emits a workspace skill and config file for openclaw", () => {
    const files = createMoltnetSkillFiles(createAgent("openclaw"), createArtifacts());

    expect(files.map((file) => file.path)).toEqual([
      "workspace/skills/moltnet/SKILL.md",
      "workspace/.moltnet/config.json"
    ]);
    expect(files[0]?.content).toContain("name: moltnet");
    expect(files[1]?.content).toContain('"base_url": "http://127.0.0.1:8787"');
    expect(files[1]?.content).toContain('"member_id": "orchestrator"');
  });

  it("emits runtime-specific skill copies for tinyclaw", () => {
    const files = createMoltnetSkillFiles(createAgent("tinyclaw"), createArtifacts());

    expect(files.map((file) => file.path)).toEqual([
      "workspace/orchestrator/.agents/skills/moltnet/SKILL.md",
      "workspace/orchestrator/.claude/skills/moltnet/SKILL.md",
      "workspace/orchestrator/.moltnet/config.json"
    ]);
  });

  it("emits the workspace skill layout for picoclaw", () => {
    const files = createMoltnetSkillFiles(createAgent("picoclaw"), createArtifacts());

    expect(files.map((file) => file.path)).toEqual([
      "workspace/skills/moltnet/SKILL.md",
      "workspace/.moltnet/config.json"
    ]);
  });

  it("returns no files when the agent has no moltnet attachments", () => {
    const agent = createAgent("picoclaw");
    agent.surfaces = undefined;

    expect(createMoltnetSkillFiles(agent, createArtifacts())).toEqual([]);
  });

  it("omits optional room and dm sections when the attachment does not declare them", () => {
    const agent = createAgent("openclaw");
    agent.surfaces = {
      moltnet: [
        {
          memberId: "orchestrator",
          network: "local_lab",
          rooms: undefined,
          teamSource: "/tmp/team/Spawnfile"
        }
      ]
    };

    const files = createMoltnetSkillFiles(agent, createArtifacts());

    expect(files[1]?.content).not.toContain('"rooms"');
    expect(files[1]?.content).not.toContain('"dms"');
  });

  it("omits optional policy fields when room and dm policies leave them unset", () => {
    const agent = createAgent("openclaw");
    agent.surfaces = {
      moltnet: [
        {
          dms: {
            enabled: true
          },
          memberId: "orchestrator",
          network: "local_lab",
          rooms: {
            research: {}
          },
          teamSource: "/tmp/team/Spawnfile"
        }
      ]
    };

    const files = createMoltnetSkillFiles(agent, createArtifacts());

    expect(files[1]?.content).toContain('"enabled": true');
    expect(files[1]?.content).not.toContain('"reply":');
    expect(files[1]?.content).not.toContain('"read":');
  });

  it("fails when the attachment member id is missing", () => {
    const agent = createAgent("openclaw");
    if (agent.surfaces?.moltnet?.[0]) {
      agent.surfaces.moltnet[0].memberId = null;
    }

    expect(() => createMoltnetSkillFiles(agent, createArtifacts())).toThrow(
      /requires a resolved member id/
    );
  });

  it("fails when an attachment cannot be matched to a generated server plan", () => {
    const artifacts = createArtifacts();
    artifacts.serverPlans = [];

    expect(() => createMoltnetSkillFiles(createAgent("openclaw"), artifacts)).toThrow(
      /Unable to resolve Moltnet server plan/
    );
  });

  it("fails when the runtime does not have a Moltnet skill layout", () => {
    const agent = createAgent("openclaw");
    (agent.runtime as { name: string; options: Record<string, unknown> }).name = "zeroclaw";

    expect(() => createMoltnetSkillFiles(agent, createArtifacts())).toThrow(
      /does not know how to emit files for runtime zeroclaw/
    );
  });
});
