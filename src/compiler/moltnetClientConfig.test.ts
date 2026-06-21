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
  persistentMounts: [],
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
      rooms: [
        {
          id: "research",
          members: ["orchestrator"],
          visibility: "public",
          write_policy: "members"
        }
      ],
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

const createAgent = (runtime: "openclaw" | "picoclaw" | "pi"): ResolvedAgentNode => ({
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
          wake: "never"
        },
        memberId: "orchestrator",
        network: "local_lab",
        rooms: {
          research: {
            wake: "all"
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
    expect(files[0]?.content).toContain('"visibility": "public"');
    expect(files[0]?.content).toContain('"write_policy": "members"');
  });

  it("resolves the workspace skill layout for picoclaw", () => {
    expect(resolveMoltnetWorkspaceLayout("picoclaw", "orchestrator")).toEqual({
      clientConfigPath: "workspace/.moltnet/config.json",
      cliRuntime: "picoclaw",
      skillPaths: ["workspace/skills/moltnet/SKILL.md"],
      workspaceRootPath: "workspace"
    });
  });

  it("resolves the Codex-style workspace skill layout for pi", () => {
    expect(resolveMoltnetWorkspaceLayout("pi", "orchestrator")).toEqual({
      clientConfigPath: "workspace/.moltnet/config.json",
      cliRuntime: "codex",
      skillPaths: [
        "workspace/.agents/skills/moltnet/SKILL.md",
        "workspace/.codex/skills/moltnet/SKILL.md"
      ],
      workspaceRootPath: "workspace"
    });

    const files = createMoltnetClientConfigFiles(createAgent("pi"), createArtifacts());
    expect(files.map((file) => file.path)).toEqual(["workspace/.moltnet/config.json"]);
    expect(files[0]?.content).toContain('"runtime": "pi"');
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

  it("uses the compiled agent slug for generated open-registration token paths", () => {
    const artifacts = createArtifacts();
    const [serverPlan] = artifacts.serverPlans;
    if (serverPlan) {
      serverPlan.server = {
        ...serverPlan.server,
        auth: {
          mode: "bearer",
          agent_registration: "open",
          public_read: true
        }
      };
    }
    const agent = createAgent("openclaw");

    const files = createMoltnetClientConfigFiles(agent, artifacts, "agent-slug");

    expect(files[0]?.content)
      .toContain('"token_path": "/var/lib/spawnfile/agents/agent-slug/state/moltnet/local_lab-orchestrator.token"');
    expect(files[0]?.content)
      .not.toContain("/var/lib/spawnfile/agents/orchestrator/state/moltnet/local_lab-orchestrator.token");
  });

  it("fails when the runtime does not have a Moltnet workspace layout", () => {
    expect(() => resolveMoltnetWorkspaceLayout("zeroclaw", "orchestrator")).toThrow(
      /does not know how to emit files for runtime zeroclaw/
    );
  });
});
