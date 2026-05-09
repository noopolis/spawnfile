import { describe, expect, it } from "vitest";

import {
  createMoltnetClientConfigFiles,
  resolveMoltnetWorkspaceLayout
} from "./moltnetClientConfig.js";
import type { MoltnetArtifacts } from "./moltnetArtifacts.js";
import type { ResolvedAgentNode } from "./types.js";

const createArtifacts = (): MoltnetArtifacts => ({
  files: [],
  nodePlans: [],
  ports: [8787],
  publishedPorts: [],
  serverPlans: [
    {
      baseUrl: "http://127.0.0.1:8787",
      id: "research-cell-local_lab",
      mode: "managed",
      name: "Local Lab",
      networkId: "local_lab",
      port: 8787,
      rooms: [{ id: "research", members: ["orchestrator"] }],
      server: {
        auth: { mode: "none" },
        listen: { bind: "127.0.0.1", port: 8787 },
        mode: "managed",
        store: { kind: "memory" }
      },
      secretPatches: [],
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
          reply: "never"
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

describe("moltnetClientConfig", () => {
  it("emits a workspace config file for openclaw", () => {
    const files = createMoltnetClientConfigFiles(createAgent("openclaw"), createArtifacts());

    expect(files.map((file) => file.path)).toEqual(["workspace/.moltnet/config.json"]);
    expect(files[0]?.content).toContain('"base_url": "http://127.0.0.1:8787"');
    expect(files[0]?.content).toContain('"member_id": "orchestrator"');
  });

  it("resolves runtime-specific skill and config layout for tinyclaw", () => {
    expect(resolveMoltnetWorkspaceLayout("tinyclaw", "orchestrator")).toEqual({
      clientConfigPath: "workspace/orchestrator/.moltnet/config.json",
      cliRuntime: "tinyclaw",
      skillPaths: [
        "workspace/orchestrator/.agents/skills/moltnet/SKILL.md",
        "workspace/orchestrator/.claude/skills/moltnet/SKILL.md"
      ],
      workspaceRootPath: "workspace/orchestrator"
    });
  });

  it("resolves the workspace skill layout for picoclaw", () => {
    expect(resolveMoltnetWorkspaceLayout("picoclaw", "orchestrator")).toEqual({
      clientConfigPath: "workspace/.moltnet/config.json",
      cliRuntime: "picoclaw",
      skillPaths: ["workspace/skills/moltnet/SKILL.md"],
      workspaceRootPath: "workspace"
    });
  });

  it("returns no files when the agent has no moltnet attachments", () => {
    const agent = createAgent("picoclaw");
    agent.surfaces = undefined;

    expect(createMoltnetClientConfigFiles(agent, createArtifacts())).toEqual([]);
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

    const files = createMoltnetClientConfigFiles(agent, createArtifacts());

    expect(files[0]?.content).not.toContain('"rooms"');
    expect(files[0]?.content).not.toContain('"dms"');
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

    const files = createMoltnetClientConfigFiles(agent, createArtifacts());

    expect(files[0]?.content).toContain('"enabled": true');
    expect(files[0]?.content).not.toContain('"reply":');
    expect(files[0]?.content).not.toContain('"read":');
  });

  it("fails when the attachment member id is missing", () => {
    const agent = createAgent("openclaw");
    if (agent.surfaces?.moltnet?.[0]) {
      agent.surfaces.moltnet[0].memberId = null;
    }

    expect(() => createMoltnetClientConfigFiles(agent, createArtifacts())).toThrow(
      /requires a resolved member id/
    );
  });

  it("fails when an attachment cannot be matched to a generated server plan", () => {
    const artifacts = createArtifacts();
    artifacts.serverPlans = [];

    expect(() => createMoltnetClientConfigFiles(createAgent("openclaw"), artifacts)).toThrow(
      /Unable to resolve Moltnet server plan/
    );
  });

  it("falls back to the shared network server plan when a representative context has a different team source", () => {
    const agent = createAgent("openclaw");
    if (agent.surfaces?.moltnet?.[0]) {
      agent.surfaces.moltnet[0].teamSource = "/tmp/child/Spawnfile";
    }

    const files = createMoltnetClientConfigFiles(agent, createArtifacts());

    expect(files[0]?.content).toContain('"base_url": "http://127.0.0.1:8787"');
    expect(files[0]?.content).toContain('"network_id": "local_lab"');
  });

  it("fails when the runtime does not have a Moltnet workspace layout", () => {
    expect(() => resolveMoltnetWorkspaceLayout("zeroclaw", "orchestrator")).toThrow(
      /does not know how to emit files for runtime zeroclaw/
    );
  });
});
