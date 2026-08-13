import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { removeDirectory, ensureDirectory, writeUtf8File } from "../filesystem/index.js";
import { manifestSchema, renderSpawnfile } from "../manifest/index.js";
import { buildCompilePlan } from "./buildCompilePlan.js";
import { resolvePlanMoltnetAttachments } from "./moltnetResolution.js";
import { validateAllowedWakeSenders } from "./moltnetAllowedWakeSendersValidation.js";
import type { CompilePlan, ResolvedAgentNode, ResolvedTeamNode } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeDirectory));
});

const createAgent = (surfaces: ResolvedAgentNode["surfaces"]): ResolvedAgentNode => ({
  description: "",
  docs: [],
  env: {},
  execution: undefined,
  kind: "agent",
  mcpServers: [],
  name: "agent",
  policyMode: null,
  policyOnDegrade: null,
  runtime: { name: "openclaw", options: {} },
  secrets: [],
  skills: [],
  source: "/tmp/agents/agent/Spawnfile",
  surfaces,
  subagents: []
});

const createTeam = (overrides: Partial<ResolvedTeamNode>): ResolvedTeamNode => ({
  description: "",
  docs: [],
  external: [],
  externalExplicit: false,
  kind: "team",
  lead: null,
  members: [
    {
      id: "agent",
      kind: "agent",
      nodeSource: "/tmp/agents/agent/Spawnfile",
      runtimeName: "openclaw"
    }
  ],
  mode: "swarm",
  name: "team",
  networks: [{ id: "social", name: "Social", provider: "moltnet", rooms: [] }],
  policyMode: null,
  policyOnDegrade: null,
  shared: {
    env: {},
    mcpServers: [],
    secrets: [],
    skills: []
  },
  source: "/tmp/team/Spawnfile",
  ...overrides
});

const withResolvedPlan = (team: ResolvedTeamNode, agent: ResolvedAgentNode): CompilePlan => ({
  edges: [],
  memberships: [
    { agentSource: agent.source, memberId: "agent", teamName: team.name, teamSource: team.source }
  ],
  nodes: [
    { id: "agent", kind: "agent", runtimeName: "openclaw", slug: "agent", value: agent },
    { id: "team", kind: "team", runtimeName: null, slug: "team", value: team }
  ],
  root: team.source,
  runtimes: { openclaw: { nodeIds: ["agent"] } }
});

const resolveAndValidate = (team: ResolvedTeamNode, agent: ResolvedAgentNode): void => {
  const plan = withResolvedPlan(team, agent);
  resolvePlanMoltnetAttachments(plan);
  validateAllowedWakeSenders(plan);
};

describe("moltnetAllowedWakeSendersValidation", () => {
  it("accepts sender references on same-network root services", () => {
    const team = createTeam({
      externalParticipants: [{
        id: "world",
        kind: "service",
        surfaces: { moltnet: [{ auth: { token_id: "world" }, dms: { enabled: true }, network: "social" }] }
      }]
    });
    const agent = createAgent({
      moltnet: [{
        dms: { enabled: true, allowedWakeSenders: ["world"] },
        memberId: null,
        network: "social",
        teamSource: null
      }]
    });

    expect(() => resolveAndValidate(team, agent)).not.toThrow();
  });

  it("preserves explicit empties without external participants", () => {
    const team = createTeam({});
    const agent = createAgent({
      moltnet: [{ dms: { enabled: true, allowedWakeSenders: [] }, memberId: null, network: "social", teamSource: null }]
    });
    expect(() => resolveAndValidate(team, agent)).not.toThrow();
  });

  it("allows absent and explicit empty sender lists while rejecting non-empty without source-root authority", () => {
    const createRootlessPlan = (agent: ResolvedAgentNode): CompilePlan => ({
      edges: [],
      nodes: [{ id: "agent", kind: "agent", runtimeName: "openclaw", slug: "agent", value: agent }],
      root: agent.source,
      runtimes: { openclaw: { nodeIds: ["agent"] } }
    });

    const agentWithoutSenders = createAgent({
      moltnet: [{ dms: { enabled: true }, memberId: null, network: "social", teamSource: null }]
    });
    const agentWithEmptySenderList = createAgent({
      moltnet: [{ dms: { enabled: true, allowedWakeSenders: [] }, memberId: null, network: "social", teamSource: null }]
    });
    const agentWithSender = createAgent({
      moltnet: [{ dms: { enabled: true, allowedWakeSenders: ["world"] }, memberId: null, network: "social", teamSource: null }]
    });

    expect(() => validateAllowedWakeSenders(createRootlessPlan(agentWithoutSenders))).not.toThrow();
    expect(() => validateAllowedWakeSenders(createRootlessPlan(agentWithEmptySenderList))).not.toThrow();
    expect(() => validateAllowedWakeSenders(createRootlessPlan(agentWithSender))).toThrow(
      "Moltnet attachment validation requires exactly one source-root team; found 0"
    );
  });

  it("rejects non-empty lists when no root external participant matches", () => {
    const team = createTeam({});
    const agent = createAgent({
      moltnet: [{ dms: { enabled: true, allowedWakeSenders: ["world"] }, memberId: null, network: "social", teamSource: null }]
    });
    expect(() => resolveAndValidate(team, agent)).toThrow(
      "has 0 root matches for allowed_wake_senders entry world"
    );
  });

  it("rejects sender matches on a different network", () => {
    const team = createTeam({
      externalParticipants: [{
        id: "world",
        kind: "service",
        surfaces: { moltnet: [{ auth: { token_id: "world" }, dms: { enabled: true }, network: "other" }] }
      }]
    });
    const agent = createAgent({
      moltnet: [{ dms: { enabled: true, allowedWakeSenders: ["world"] }, memberId: null, network: "social", teamSource: null }]
    });
    expect(() => resolveAndValidate(team, agent)).toThrow(
      "has 0 root matches for allowed_wake_senders entry world"
    );
  });

  it("rejects sender matches declared on a nested team and not on the root team", () => {
    const child = createTeam({
      source: "/tmp/child/Spawnfile",
      name: "child",
      externalParticipants: [{
        id: "world",
        kind: "service",
        surfaces: { moltnet: [{ auth: { token_id: "world" }, dms: { enabled: true }, network: "social" }] }
      }]
    });
    const root = createTeam({
      source: "/tmp/root/Spawnfile",
      external: ["child"],
      externalExplicit: true,
      members: [
        ...createTeam({}).members,
        {
          id: "child",
          kind: "team",
          nodeSource: child.source,
          runtimeName: null
        }
      ]
    });
    const agent = createAgent({
      moltnet: [{ dms: { enabled: true, allowedWakeSenders: ["world"] }, memberId: null, network: "social", teamSource: null }]
    });
    const plan: CompilePlan = {
      edges: [],
      memberships: [
        { agentSource: agent.source, memberId: "agent", teamName: root.name, teamSource: root.source }
      ],
      nodes: [
        { id: "agent", kind: "agent", runtimeName: "openclaw", slug: "agent", value: agent },
        { id: "root", kind: "team", runtimeName: null, slug: "root", value: root },
        { id: "child", kind: "team", runtimeName: null, slug: "child", value: child }
      ],
      root: root.source,
      runtimes: { openclaw: { nodeIds: ["agent"] } }
    };

    expect(() => {
      resolvePlanMoltnetAttachments(plan);
      validateAllowedWakeSenders(plan);
    }).toThrow("has 0 root matches for allowed_wake_senders entry world");
  });

  it("rejects sender matches when first team node has plan-root id but is not the source-root team", () => {
    const root = createTeam({
      source: "/tmp/root/Spawnfile",
      externalParticipants: [{
        id: "local-world",
        kind: "service",
        surfaces: { moltnet: [{ auth: { token_id: "local-world" }, dms: { enabled: true }, network: "social" }] }
      }]
    });
    const decoy = createTeam({
      source: "/tmp/decoy/Spawnfile",
      externalParticipants: [{
        id: "world",
        kind: "service",
        surfaces: { moltnet: [{ auth: { token_id: "world" }, dms: { enabled: true }, network: "social" }] }
      }]
    });
    const agent = createAgent({
      moltnet: [{
        dms: { enabled: true, allowedWakeSenders: ["world"] },
        memberId: null,
        network: "social",
        teamSource: null
      }]
    });
    const plan: CompilePlan = {
      edges: [],
      memberships: [
        { agentSource: agent.source, memberId: "agent", teamName: root.name, teamSource: root.source }
      ],
      nodes: [
        { id: "/tmp/root/Spawnfile", kind: "team", runtimeName: null, slug: "decoy", value: decoy },
        { id: "agent", kind: "agent", runtimeName: "openclaw", slug: "agent", value: agent },
        { id: "root", kind: "team", runtimeName: null, slug: "root", value: root }
      ],
      root: root.source,
      runtimes: { openclaw: { nodeIds: ["agent"] } }
    };

    expect(() => {
      resolvePlanMoltnetAttachments(plan);
      validateAllowedWakeSenders(plan);
    }).toThrow("has 0 root matches for allowed_wake_senders entry world");
  });

  it("rejects sender matches on a root service with DMS disabled", () => {
    const root = createTeam({
      externalParticipants: [{
        id: "world",
        kind: "service",
        surfaces: {
          moltnet: [{
            auth: { token_id: "world" },
            dms: { enabled: false as unknown as true },
            network: "social"
          }]
        }
      }]
    });
    const agent = createAgent({
      moltnet: [{ dms: { enabled: true, allowedWakeSenders: ["world"] }, memberId: null, network: "social", teamSource: null }]
    });
    expect(() => resolveAndValidate(root, agent)).toThrow(
      "has 0 root matches for allowed_wake_senders entry world"
    );
  });

  it("rejects non-external labels that match sender ids", () => {
    const team = createTeam({
      members: [
        { id: "agent", kind: "agent", nodeSource: "/tmp/agents/agent/Spawnfile", runtimeName: "openclaw" },
        { id: "world", kind: "agent", nodeSource: "/tmp/agents/world/Spawnfile", runtimeName: "openclaw" }
      ],
      externalParticipants: []
    });
    const agent = createAgent({
      moltnet: [{ dms: { enabled: true, allowedWakeSenders: ["world"] }, memberId: null, network: "social", teamSource: null }]
    });
    expect(() => resolveAndValidate(team, agent)).toThrow(
      "has 0 root matches for allowed_wake_senders entry world"
    );
  });

  it("rejects ambiguous root authority for duplicate sender IDs", () => {
    const team = createTeam({
      externalParticipants: [
        { id: "world", kind: "service", surfaces: { moltnet: [{ auth: { token_id: "world" }, dms: { enabled: true }, network: "social" }] } },
        { id: "world", kind: "service", surfaces: { moltnet: [{ auth: { token_id: "world" }, dms: { enabled: true }, network: "social" }] } }
      ]
    });
    const agent = createAgent({
      moltnet: [{ dms: { enabled: true, allowedWakeSenders: ["world"] }, memberId: null, network: "social", teamSource: null }]
    });
    expect(() => resolveAndValidate(team, agent)).toThrow(
      "has 2 root matches for allowed_wake_senders entry world"
    );
  });

  it("validates both inline and referenced agents in a built graph", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-wake-refs-"));
    temporaryDirectories.push(root);
    const rootManifest = manifestSchema.parse({
      kind: "team",
      members: [
        {
          id: "inline",
          runtime: "openclaw",
          workspace: { docs: { system: "AGENTS.md" } },
          surfaces: { moltnet: [{ auth: { token_id: "inline" }, network: "social", dms: { enabled: true, allowed_wake_senders: ["world"] } }] }
        },
        { id: "referenced", ref: "./agents/referenced" }
      ],
      mode: "swarm",
      name: "wake-team",
      networks: [{
        id: "social",
        name: "Social",
        provider: "moltnet",
        rooms: [{ id: "inbox", members: ["inline", "referenced"] }],
        server: {
          auth: {
            mode: "bearer",
            client: { token_id: "operator" },
            tokens: [
              { id: "operator", scopes: ["admin", "observe", "write"], secret: "SOCIAL_OPERATOR" },
              { id: "inline", agents: ["inline"], scopes: ["attach", "write"], secret: "SOCIAL_INLINE" },
              { id: "referenced", agents: ["referenced"], scopes: ["attach", "write"], secret: "SOCIAL_REFERENCED" },
              { id: "world", agents: ["world"], scopes: ["attach", "write"], secret: "SOCIAL_WORLD" }
            ]
          },
          mode: "managed",
          listen: { bind: "127.0.0.1", port: 8787 },
          direct_messages: true,
          store: { kind: "memory" }
        }
      }],
      external_participants: [{
        id: "world",
        kind: "service",
        surfaces: { moltnet: [{ auth: { token_id: "world" }, dms: { enabled: true }, network: "social" }] }
      }],
      spawnfile_version: "0.1"
    });
    const referencedAgent = renderSpawnfile({
      kind: "agent",
      name: "referenced",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      workspace: { docs: { system: "AGENTS.md" } },
      surfaces: { moltnet: [{ auth: { token_id: "referenced" }, network: "social", dms: { enabled: true, allowed_wake_senders: ["world"] } }] }
    });

    await writeUtf8File(path.join(root, "Spawnfile"), renderSpawnfile(rootManifest));
    await ensureDirectory(path.join(root, "agents", "referenced"));
    await writeUtf8File(path.join(root, "AGENTS.md"), "inline system doc");
    await writeUtf8File(path.join(root, "agents", "referenced", "AGENTS.md"), "referenced system doc");
    await writeUtf8File(path.join(root, "agents", "referenced", "Spawnfile"), referencedAgent);
    await expect(buildCompilePlan(root)).resolves.toBeDefined();
  });
});
