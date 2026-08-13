import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createDistributionFingerprint } from "../distribution/fingerprint.js";
import { WORLD_BINDINGS_IMAGE_PATH } from "../distribution/types.js";

import type { GeneratedContainerArtifacts } from "./containerArtifacts.js";
import type { MoltnetArtifacts } from "./moltnetArtifacts.js";
import { createOrganizationReadinessEvidence } from "./organizationReadyEvidence.js";
import type { CompilePlan, ResolvedAgentNode, ResolvedTeamNode } from "./types.js";

interface MutableWorldBinding {
  capability_manifest_digest: string;
  json: { auth: "bearer"; url: string };
  mcp: { auth: "bearer"; transport: "streamable_http"; url: string };
  member: { id: string; principal_id: string };
  run_id: string;
  token_env: string;
  world_instance_id: string;
}

interface MutableWorldBindings {
  artifact: { bindings: MutableWorldBinding[]; schema: "simfile.world-bindings.v1" };
  assignments: Array<{ binding: MutableWorldBinding; nodeId: string }>;
  canonicalBytes: string;
}

interface EvidenceInput {
  compileVersion: string;
  containerArtifacts: GeneratedContainerArtifacts;
  moltnetArtifacts: MoltnetArtifacts | null;
  plan: CompilePlan;
  worldBindings?: MutableWorldBindings;
}

const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const configPath = (name: string): string =>
  `/var/lib/spawnfile/moltnet/nodes/${name}.json`;

const agent = (id: string, source: string, network: string, room: string): CompilePlan["nodes"][number] => ({
  id,
  kind: "agent",
  runtimeName: "pi",
  slug: id.slice("agent:".length),
  value: {
    description: "RAW_MODEL_SENTINEL",
    docs: [],
    env: { RAW_TOKEN_ENV_SENTINEL: "RAW_TOKEN_VALUE_SENTINEL" },
    execution: undefined,
    kind: "agent",
    mcpServers: [],
    name: id,
    policyMode: null,
    policyOnDegrade: null,
    runtime: { name: "pi", options: { RAW_MODEL_OPTION_SENTINEL: "RAW_MODEL_VALUE_SENTINEL" } },
    secrets: [{ name: "RAW_CREDENTIAL_ID_SENTINEL", value: "RAW_CREDENTIAL_SECRET_SENTINEL" }] as never,
    skills: [],
    source,
    subagents: [],
    surfaces: {
      moltnet: [{
        auth: { tokenId: "RAW_ATTACHMENT_TOKEN_SENTINEL" },
        memberId: id.slice("agent:".length),
        network,
        rooms: { [room]: {} },
        teamSource: "root"
      }]
    }
  } as ResolvedAgentNode
});

const team = (): CompilePlan["nodes"][number] => ({
  id: "team:root",
  kind: "team",
  runtimeName: null,
  slug: "root",
  value: {
    description: "",
    docs: [],
    external: [],
    externalParticipants: [{ id: "world", kind: "service", surfaces: { moltnet: [] } }],
    kind: "team",
    lead: null,
    members: [
      { id: "zeta", kind: "agent", nodeSource: "agent-zeta", runtimeName: "pi" },
      { id: "alpha", kind: "agent", nodeSource: "agent-alpha", runtimeName: "pi" }
    ],
    mode: "swarm",
    name: "Readiness Team",
    policyMode: null,
    policyOnDegrade: null,
    shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
    source: "root"
  } as ResolvedTeamNode
});

const plan = (): CompilePlan => ({
  edges: [
    { from: "team:root", kind: "team_member", label: "zeta", to: "agent:zeta" },
    { from: "team:root", kind: "team_member", label: "alpha", to: "agent:alpha" }
  ],
  moltnetRoomMemberships: [
    { agentName: "Zeta", agentSource: "agent-zeta", concreteMemberId: "zeta", declaredSlot: "zeta", declaringTeamName: "Readiness Team", declaringTeamSource: "root", directTeamName: "Readiness Team", directTeamSource: "root", networkId: "z-net", roomId: "z-room" },
    { agentName: "Alpha", agentSource: "agent-alpha", concreteMemberId: "alpha", declaredSlot: "alpha", declaringTeamName: "Readiness Team", declaringTeamSource: "root", directTeamName: "Readiness Team", directTeamSource: "root", networkId: "a-net", roomId: "a-room" }
  ],
  nodes: [team(), agent("agent:zeta", "agent-zeta", "z-net", "z-room"), agent("agent:alpha", "agent-alpha", "a-net", "a-room")],
  organizationIdentity: {
    agentMembers: [
      { authoredMemberKey: "alpha", kind: "agent", memberId: "alpha", principalId: "agent:alpha" },
      { authoredMemberKey: "zeta", kind: "agent", memberId: "zeta", principalId: "agent:zeta" }
    ],
    externalParticipants: [{ authoredParticipantKey: "world", kind: "service", memberId: "world", principalId: "system:world" }]
  },
  root: "root",
  runtimes: { pi: { nodeIds: ["agent:zeta", "agent:alpha"] } }
});

const worldBindings = (): MutableWorldBindings => {
  const bindings = ["zeta", "alpha"].map((memberId) => ({
    capability_manifest_digest: "RAW_CAPABILITY_DIGEST_SENTINEL",
    json: { auth: "bearer" as const, url: "https://RAW_JSON_URL_SENTINEL.invalid" },
    mcp: { auth: "bearer" as const, transport: "streamable_http" as const, url: "https://RAW_MCP_URL_SENTINEL.invalid" },
    member: { id: memberId, principal_id: `agent:${memberId}` },
    run_id: "RAW_RUN_ID_SENTINEL",
    token_env: "RAW_WORLD_TOKEN_ENV_SENTINEL",
    world_instance_id: "RAW_WORLD_INSTANCE_SENTINEL"
  }));
  const canonicalBytes = JSON.stringify({ bindings, schema: "simfile.world-bindings.v1" });
  return {
    artifact: { bindings, schema: "simfile.world-bindings.v1" },
    assignments: [
      { binding: bindings[0]!, nodeId: "agent:zeta" },
      { binding: bindings[1]!, nodeId: "agent:alpha" }
    ],
    canonicalBytes
  };
};

const artifacts = (): MoltnetArtifacts => ({
  files: [
    { content: "{\"credential\":\"RAW_CONFIG_SECRET_ZETA\"}\n", path: `container/rootfs${configPath("zeta")}` },
    { content: "{\"credential\":\"RAW_CONFIG_SECRET_ALPHA\"}\n", path: `container/rootfs${configPath("alpha")}` }
  ],
  nodePlans: [
    { configPath: configPath("zeta"), credentialAgentId: "RAW_CREDENTIAL_AGENT_SENTINEL", credentialId: "RAW_CREDENTIAL_ID_SENTINEL", credentialSecret: "RAW_CREDENTIAL_SECRET_SENTINEL", memberId: "zeta", networkId: "z-net" },
    { configPath: configPath("alpha"), credentialAgentId: "RAW_CREDENTIAL_AGENT_SENTINEL", credentialId: "RAW_CREDENTIAL_ID_SENTINEL", credentialSecret: "RAW_CREDENTIAL_SECRET_SENTINEL", memberId: "alpha", networkId: "a-net" }
  ],
  persistentMounts: [{ id: "RAW_HOST_OUTPUT_PATH_SENTINEL", mountPath: "/RAW_HOST_PATH_SENTINEL", reason: "RAW_REASON_SENTINEL", volumeName: "RAW_VOLUME_SENTINEL" }],
  ports: [4123],
  publishedPorts: [4123],
  serverPlans: [
    { baseUrl: "https://RAW_SERVER_URL_SENTINEL.invalid", id: "server:z", mode: "external", name: "RAW_SERVER_HOST_SENTINEL", networkId: "z-net", rooms: [{ id: "z-room", members: ["zeta"] }], secretPatches: [{ name: "RAW_SECRET_PATCH_TOKEN_SENTINEL", value: "RAW_SECRET_PATCH_VALUE_SENTINEL" }] as never, server: { RAW_SERVER_OBJECT_SENTINEL: "RAW_SERVER_VALUE_SENTINEL" } as never, teamSource: "root" },
    { baseUrl: "https://RAW_SERVER_URL_SENTINEL.invalid", id: "server:a", mode: "managed", name: "RAW_SERVER_HOST_SENTINEL", networkId: "a-net", port: 4123, rooms: [{ id: "a-room", members: ["alpha"] }], secretPatches: [{ name: "RAW_SECRET_PATCH_TOKEN_SENTINEL", value: "RAW_SECRET_PATCH_VALUE_SENTINEL" }] as never, server: { RAW_SERVER_OBJECT_SENTINEL: "RAW_SERVER_VALUE_SENTINEL" } as never, teamSource: "root" }
  ]
});

const distribution = (bindings: MutableWorldBindings | undefined): GeneratedContainerArtifacts["distribution"] => {
  const body = {
    internal_ports: [], model_auth_methods: {},
    moltnet: { networks: [{ binding: "env" as const, id: "a-net", server_mode: "managed" as const }, { binding: "env" as const, id: "z-net", server_mode: "external" as const }] },
    organization: { agents: [], project: "Readiness Team", teams: [] }, persistent_mounts: [], port_mappings: [], ports: [], resources: [], runtime_instances: [],
    secrets: { model: [], project: [], runtime: [], surface: [] }, version: "spawnfile.distribution-report.v1" as const,
    ...(bindings ? { world_bindings: { artifact_path: WORLD_BINDINGS_IMAGE_PATH as typeof WORLD_BINDINGS_IMAGE_PATH, digest: digest(bindings.canonicalBytes), schema: "simfile.world-bindings.v1" as const } } : {})
  };
  const fingerprint = createDistributionFingerprint(body);
  return { fingerprint, labels: {}, report: { compile_fingerprint: fingerprint, generated_at: "2026-07-22T00:00:00.000Z", ...body } };
};

const input = (): EvidenceInput => {
  const resolvedBindings = worldBindings();
  return {
    compileVersion: "0.1",
    containerArtifacts: {
      distribution: distribution(resolvedBindings), executablePaths: [], files: [],
      report: { dockerfile: "Dockerfile", entrypoint: "entrypoint.sh", env_example: ".env.example", internal_ports: [], model_secrets_required: [], port_mappings: [], ports: [], published_ports: [], runtime_homes: [], runtime_instances: [], runtime_secrets_required: [], runtimes_installed: [], secrets_required: [] }
    } as GeneratedContainerArtifacts,
    moltnetArtifacts: artifacts(), plan: plan(), worldBindings: resolvedBindings
  };
};

const reseal = (value: EvidenceInput): void => {
  const report = value.containerArtifacts.distribution.report;
  const { compile_fingerprint: _fingerprint, generated_at: _generatedAt, ...body } = report;
  const fingerprint = createDistributionFingerprint(body);
  report.compile_fingerprint = fingerprint;
  value.containerArtifacts.distribution.fingerprint = fingerprint;
};

const collectSourceObjects = (value: unknown, seen: WeakSet<object>): void => {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) collectSourceObjects(child, seen);
};

const assertDeepFrozenAcyclic = (
  value: unknown,
  seen = new WeakSet<object>(),
  sourceObjects?: WeakSet<object>
): void => {
  if (!value || typeof value !== "object") return;
  expect(seen.has(value)).toBe(false);
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  expect(sourceObjects?.has(value) ?? false).toBe(false);
  for (const child of Object.values(value)) assertDeepFrozenAcyclic(child, seen, sourceObjects);
};

describe("createOrganizationReadinessEvidence", () => {
  it("projects canonical, sorted, deeply immutable facts without raw aliases or secrets", () => {
    const source = input();
    const evidence = createOrganizationReadinessEvidence(source);
    expect(evidence).toMatchObject({
      compileFingerprint: source.containerArtifacts.distribution.fingerprint,
      compileVersion: "0.1",
      organizationMembers: [{ memberId: "alpha", nodeId: "agent:alpha" }, { memberId: "zeta", nodeId: "agent:zeta" }],
      projectLabel: "Readiness-Team",
      worldBindings: { artifactPath: WORLD_BINDINGS_IMAGE_PATH, assignments: [{ memberId: "alpha", nodeId: "agent:alpha" }, { memberId: "zeta", nodeId: "agent:zeta" }], digest: digest(source.worldBindings!.canonicalBytes), schema: "simfile.world-bindings.v1" }
    });
    expect(evidence.networks.map((network) => network.id)).toEqual(["a-net", "z-net"]);
    expect(evidence.networks[0]).toMatchObject({ internalPort: 4123, mode: "managed", rooms: [{ id: "a-room", members: ["alpha"] }] });
    expect(evidence.networks[1]?.nodes[0]?.sha256).toBe(digest(source.moltnetArtifacts!.files[0]!.content));
    expect(JSON.stringify(evidence)).not.toMatch(/RAW_[A-Z_]+_SENTINEL|RAW_CONFIG_SECRET_[A-Z]+/u);
    expect(evidence).not.toBe(source.plan);
    expect(evidence.networks).not.toBe(source.moltnetArtifacts!.serverPlans as never);
    const sourceObjects = new WeakSet<object>();
    for (const branch of [
      source.containerArtifacts.distribution,
      source.containerArtifacts.distribution.report,
      source.plan.organizationIdentity,
      source.plan.nodes,
      source.plan.moltnetRoomMemberships,
      source.moltnetArtifacts?.serverPlans,
      source.moltnetArtifacts?.nodePlans,
      source.moltnetArtifacts?.files,
      source.worldBindings?.artifact,
      source.worldBindings?.assignments,
      source.worldBindings?.canonicalBytes
    ]) collectSourceObjects(branch, sourceObjects);
    const bytes = JSON.stringify(evidence);
    const distributionReport = source.containerArtifacts.distribution.report;
    distributionReport.compile_fingerprint = "sf1:source-report-mutated";
    source.containerArtifacts.distribution.fingerprint = "sf1:source-fingerprint-mutated";
    source.containerArtifacts.distribution.report.organization.project = "source-project-mutated";
    source.containerArtifacts.distribution.report.world_bindings!.digest = digest("source-binding-evidence-mutated");
    (source.plan.organizationIdentity!.agentMembers[0] as unknown as { memberId: string }).memberId = "source-member-mutated";
    source.plan.nodes[1]!.id = "agent:changed";
    ((source.plan.nodes[1]!.value as ResolvedAgentNode).surfaces!.moltnet![0]!.rooms as Record<string, unknown>).sourceRoom = {};
    ((source.plan.nodes[1]!.value as ResolvedAgentNode).surfaces!.moltnet![0]!).network = "source-network-mutated";
    source.plan.moltnetRoomMemberships![0]!.roomId = "source-room-mutated";
    source.moltnetArtifacts!.serverPlans[0]!.name = "source-server-mutated";
    source.moltnetArtifacts!.serverPlans[0]!.rooms[0]!.members[0] = "source-room-member-mutated";
    source.moltnetArtifacts!.serverPlans[0]!.networkId = "source-network-id-mutated";
    source.moltnetArtifacts!.nodePlans[0]!.configPath = "/source-config-path-mutated";
    source.moltnetArtifacts!.nodePlans[0]!.credentialSecret = "source-credential-mutated";
    source.moltnetArtifacts!.files[0]!.content = "source-config-bytes-mutated";
    source.worldBindings!.canonicalBytes = "source-canonical-bytes-mutated";
    (source.worldBindings!.artifact as unknown as { schema: string }).schema = "source-artifact-mutated";
    source.worldBindings!.assignments[0]!.nodeId = "agent:changed";
    source.worldBindings!.assignments[0]!.binding.member.principal_id = "source-principal-mutated";
    expect(JSON.stringify(evidence)).toBe(bytes);
    assertDeepFrozenAcyclic(evidence, new WeakSet<object>(), sourceObjects);
  });

  it("keeps generic projects explicit and empty", () => {
    const source = input();
    source.plan = { edges: [], nodes: [], root: "generic", runtimes: {} };
    source.moltnetArtifacts = null;
    source.worldBindings = undefined;
    source.containerArtifacts.distribution = distribution(undefined);
    source.containerArtifacts.distribution.report.moltnet.networks = [];
    reseal(source);
    const evidence = createOrganizationReadinessEvidence(source);
    expect(evidence).toMatchObject({ hasExternalMoltnet: false, networks: [], organizationMembers: [], worldBindings: null });
  });

  it.each([
    ["missing node plan", /Moltnet attachment a-net\/alpha has no node plan/u, (value: EvidenceInput) => { expect(value.moltnetArtifacts!.nodePlans).toHaveLength(2); value.moltnetArtifacts!.nodePlans.pop(); expect(value.moltnetArtifacts!.nodePlans).toHaveLength(1); }],
    ["extra orphan node plan", /Moltnet node a-net\/world has no attachment/u, (value: EvidenceInput) => { expect(value.moltnetArtifacts!.nodePlans).toHaveLength(2); value.moltnetArtifacts!.nodePlans.push({ configPath: configPath("orphan"), memberId: "world", networkId: "a-net" }); value.moltnetArtifacts!.files.push({ content: "{}", path: `container/rootfs${configPath("orphan")}` }); expect(value.moltnetArtifacts!.nodePlans.at(-1)?.memberId).toBe("world"); }],
    ["nonexistent network", /Moltnet attachment references nonexistent network gone/u, (value: EvidenceInput) => { const attachment = (value.plan.nodes[1]!.value as ResolvedAgentNode).surfaces!.moltnet![0]!; expect(attachment.network).toBe("z-net"); attachment.network = "gone"; expect(attachment.network).toBe("gone"); }],
    ["duplicate network id", /duplicate Moltnet network: z-net/u, (value: EvidenceInput) => { expect(value.moltnetArtifacts!.serverPlans).toHaveLength(2); value.moltnetArtifacts!.serverPlans.push({ ...value.moltnetArtifacts!.serverPlans[0]! }); expect(value.moltnetArtifacts!.serverPlans.at(-1)?.networkId).toBe("z-net"); }],
    ["duplicate server id", /duplicate Moltnet server: server:z/u, (value: EvidenceInput) => { expect(value.moltnetArtifacts!.serverPlans[1]!.id).toBe("server:a"); value.moltnetArtifacts!.serverPlans[1]!.id = "server:z"; expect(value.moltnetArtifacts!.serverPlans[1]!.id).toBe("server:z"); }],
    ["duplicate node member", /duplicate Moltnet node member/u, (value: EvidenceInput) => { expect(value.moltnetArtifacts!.nodePlans[1]!.memberId).toBe("alpha"); value.moltnetArtifacts!.nodePlans[1]!.memberId = "zeta"; value.moltnetArtifacts!.nodePlans[1]!.networkId = "z-net"; expect(value.moltnetArtifacts!.nodePlans[1]!.memberId).toBe("zeta"); }],
    ["globally duplicate config path", /duplicate Moltnet node config/u, (value: EvidenceInput) => { expect(value.moltnetArtifacts!.nodePlans[1]!.configPath).toBe(configPath("alpha")); value.moltnetArtifacts!.nodePlans[1]!.configPath = configPath("zeta"); expect(value.moltnetArtifacts!.nodePlans[1]!.configPath).toBe(configPath("zeta")); }],
    ["missing emitted config", /node config .* is not emitted exactly once/u, (value: EvidenceInput) => { expect(value.moltnetArtifacts!.files).toHaveLength(2); value.moltnetArtifacts!.files = value.moltnetArtifacts!.files.slice(1); expect(value.moltnetArtifacts!.files).toHaveLength(1); }],
    ["duplicate emitted config", /node config .* is not emitted exactly once/u, (value: EvidenceInput) => { expect(value.moltnetArtifacts!.files).toHaveLength(2); value.moltnetArtifacts!.files.push({ ...value.moltnetArtifacts!.files[0]! }); expect(value.moltnetArtifacts!.files).toHaveLength(3); }],
    ["missing room", /Moltnet attachment room z-net\/z-room lacks zeta/u, (value: EvidenceInput) => { expect(value.moltnetArtifacts!.serverPlans[0]!.rooms).toHaveLength(1); value.moltnetArtifacts!.serverPlans[0]!.rooms = []; expect(value.moltnetArtifacts!.serverPlans[0]!.rooms).toHaveLength(0); }],
    ["duplicate room", /duplicate Moltnet room on z-net/u, (value: EvidenceInput) => { expect(value.moltnetArtifacts!.serverPlans[0]!.rooms).toHaveLength(1); value.moltnetArtifacts!.serverPlans[0]!.rooms.push({ ...value.moltnetArtifacts!.serverPlans[0]!.rooms[0]! }); value.plan.moltnetRoomMemberships = []; expect(value.moltnetArtifacts!.serverPlans[0]!.rooms).toHaveLength(2); }],
    ["duplicate room member", /duplicate Moltnet room member on z-net\/z-room/u, (value: EvidenceInput) => { expect(value.moltnetArtifacts!.serverPlans[0]!.rooms[0]!.members).toEqual(["zeta"]); value.moltnetArtifacts!.serverPlans[0]!.rooms[0]!.members.push("zeta"); expect(value.moltnetArtifacts!.serverPlans[0]!.rooms[0]!.members).toEqual(["zeta", "zeta"]); }],
    ["attachment room mismatch", /Moltnet attachment room z-net\/bad lacks zeta/u, (value: EvidenceInput) => { const rooms = (value.plan.nodes[1]!.value as ResolvedAgentNode).surfaces!.moltnet![0]!.rooms as Record<string, unknown>; expect(rooms).not.toHaveProperty("bad"); rooms.bad = {}; expect(rooms).toHaveProperty("bad"); }],
    ["resolved room membership mismatch", /Moltnet room membership z-net\/a-room lacks zeta/u, (value: EvidenceInput) => { expect(value.plan.moltnetRoomMemberships![0]!.roomId).toBe("z-room"); value.plan.moltnetRoomMemberships![0]!.roomId = "a-room"; expect(value.plan.moltnetRoomMemberships![0]!.roomId).toBe("a-room"); }],
    ["organization duplicate member", /duplicate organization member: alpha/u, (value: EvidenceInput) => { const members = value.plan.organizationIdentity!.agentMembers; expect(members.map((member) => member.memberId)).toEqual(["alpha", "zeta"]); (members[1] as { memberId: string }).memberId = "alpha"; expect(members.map((member) => member.memberId)).toEqual(["alpha", "alpha"]); }],
    ["organization cardinality mismatch", /organization graph cardinality mismatch for team Readiness Team/u, (value: EvidenceInput) => { expect(value.plan.organizationIdentity!.agentMembers).toHaveLength(2); value.plan.nodes.splice(1, 1); value.plan.edges = value.plan.edges.filter((edge) => edge.to !== "agent:zeta"); expect(value.plan.nodes).toHaveLength(2); }],
    ["distribution binding without resolved binding", /distribution contains world-binding evidence without resolved bindings/u, (value: EvidenceInput) => { expect(value.worldBindings).toBeDefined(); value.worldBindings = undefined; expect(value.worldBindings).toBeUndefined(); }],
    ["resolved binding without distribution evidence", /distribution world-binding evidence is missing or incompatible/u, (value: EvidenceInput) => { expect(value.containerArtifacts.distribution.report.world_bindings).toBeDefined(); delete value.containerArtifacts.distribution.report.world_bindings; reseal(value); expect(value.containerArtifacts.distribution.report.world_bindings).toBeUndefined(); }],
    ["binding digest mismatch", /distribution world-binding digest disagrees with resolved bindings/u, (value: EvidenceInput) => { expect(value.containerArtifacts.distribution.report.world_bindings!.digest).toBe(digest(value.worldBindings!.canonicalBytes)); value.containerArtifacts.distribution.report.world_bindings!.digest = digest("wrong"); reseal(value); expect(value.containerArtifacts.distribution.report.world_bindings!.digest).not.toBe(digest(value.worldBindings!.canonicalBytes)); }],
    ["binding schema mismatch", /distribution world-binding evidence is missing or incompatible/u, (value: EvidenceInput) => { expect(value.containerArtifacts.distribution.report.world_bindings!.schema).toBe("simfile.world-bindings.v1"); value.containerArtifacts.distribution.report.world_bindings!.schema = "bad" as never; reseal(value); expect(value.containerArtifacts.distribution.report.world_bindings!.schema).toBe("bad"); }],
    ["binding path mismatch", /distribution world-binding evidence is missing or incompatible/u, (value: EvidenceInput) => { expect(value.containerArtifacts.distribution.report.world_bindings!.artifact_path).toBe(WORLD_BINDINGS_IMAGE_PATH); value.containerArtifacts.distribution.report.world_bindings!.artifact_path = "/bad" as never; reseal(value); expect(value.containerArtifacts.distribution.report.world_bindings!.artifact_path).toBe("/bad"); }],
    ["missing binding assignment", /world-binding assignments disagree with resolved organization members/u, (value: EvidenceInput) => { expect(value.worldBindings!.assignments).toHaveLength(2); value.worldBindings!.assignments = value.worldBindings!.assignments.slice(1); expect(value.worldBindings!.assignments).toHaveLength(1); }],
    ["duplicate binding member", /duplicate world-binding member: zeta/u, (value: EvidenceInput) => { expect(value.worldBindings!.assignments[1]!.binding.member.id).toBe("alpha"); (value.worldBindings!.assignments[1]!.binding.member as { id: string }).id = "zeta"; expect(value.worldBindings!.assignments[1]!.binding.member.id).toBe("zeta"); }],
    ["wrong binding member", /world-binding assignments disagree with resolved organization members/u, (value: EvidenceInput) => { expect(value.worldBindings!.assignments[1]!.binding.member.id).toBe("alpha"); (value.worldBindings!.assignments[1]!.binding.member as { id: string }).id = "world"; expect(value.worldBindings!.assignments[1]!.binding.member.id).toBe("world"); }],
    ["wrong binding node", /duplicate world-binding node: agent:zeta/u, (value: EvidenceInput) => { expect(value.worldBindings!.assignments[1]!.nodeId).toBe("agent:alpha"); value.worldBindings!.assignments[1]!.nodeId = "agent:zeta"; expect(value.worldBindings!.assignments[1]!.nodeId).toBe("agent:zeta"); }],
    ["over-bound config path", /Moltnet config path is noncanonical/u, (value: EvidenceInput) => { expect(value.moltnetArtifacts!.nodePlans[0]!.configPath).toBe(configPath("zeta")); value.moltnetArtifacts!.nodePlans[0]!.configPath = `/${"x".repeat(256)}`; expect(value.moltnetArtifacts!.nodePlans[0]!.configPath.length).toBe(257); }],
    ["over-bound server id", /Moltnet server id is unbounded or noncanonical/u, (value: EvidenceInput) => { expect(value.moltnetArtifacts!.serverPlans[0]!.id).toBe("server:z"); value.moltnetArtifacts!.serverPlans[0]!.id = "s".repeat(129); expect(value.moltnetArtifacts!.serverPlans[0]!.id).toHaveLength(129); }],
    ["over-bound topology", /Moltnet topology exceeds organization bounds/u, (value: EvidenceInput) => { expect(value.moltnetArtifacts!.serverPlans).toHaveLength(2); while (value.moltnetArtifacts!.serverPlans.length <= 128) value.moltnetArtifacts!.serverPlans.push({ ...value.moltnetArtifacts!.serverPlans[0]!, id: `server:${value.moltnetArtifacts!.serverPlans.length}`, networkId: `n${value.moltnetArtifacts!.serverPlans.length}` }); expect(value.moltnetArtifacts!.serverPlans).toHaveLength(129); }],
    ["invalid compile version", /compile version is invalid/u, (value: EvidenceInput) => { expect(value.compileVersion).toBe("0.1"); value.compileVersion = "0.2"; expect(value.compileVersion).toBe("0.2"); }],
    ["invalid fingerprint", /compile fingerprint disagrees with canonical distribution report/u, (value: EvidenceInput) => { expect(value.containerArtifacts.distribution.fingerprint).toMatch(/^sf1:[a-f0-9]{12}$/u); value.containerArtifacts.distribution.fingerprint = "sf1:bad"; expect(value.containerArtifacts.distribution.fingerprint).toBe("sf1:bad"); }],
    ["invalid managed port", /Moltnet managed port is invalid for a-net/u, (value: EvidenceInput) => { expect(value.moltnetArtifacts!.serverPlans[1]!.port).toBe(4123); value.moltnetArtifacts!.serverPlans[1]!.port = 65_536; expect(value.moltnetArtifacts!.serverPlans[1]!.port).toBe(65_536); }]
  ])("rejects %s after proving the base topology is valid", (_label, expected, mutate) => {
    const source = input();
    expect(() => createOrganizationReadinessEvidence(source)).not.toThrow();
    mutate(source);
    expect(() => createOrganizationReadinessEvidence(source)).toThrow(expected);
  });
});
