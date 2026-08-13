import { createHash } from "node:crypto";

import { normalizeProjectLabelSlug } from "../distribution/projectName.js";
import { createDistributionFingerprint } from "../distribution/fingerprint.js";
import { WORLD_BINDINGS_IMAGE_PATH } from "../distribution/types.js";
import { SpawnfileError } from "../shared/index.js";

import type { GeneratedContainerArtifacts } from "./containerArtifacts.js";
import type { MoltnetArtifacts } from "./moltnetArtifacts.js";
import {
  MAX_ORGANIZATION_AGENT_MEMBERS,
  ORGANIZATION_MEMBER_ID_PATTERN_SOURCE,
  resolveCanonicalAgentMemberId
} from "./organizationIdentity.js";
import type { CompilePlan, ResolvedAgentNode } from "./types.js";
import type { ResolvedWorldBindings } from "./worldBindings.js";

export const ORGANIZATION_READINESS_EVIDENCE_VERSION =
  "spawnfile.organization-ready-evidence.v1" as const;

export interface OrganizationReadinessEvidence {
  readonly version: typeof ORGANIZATION_READINESS_EVIDENCE_VERSION;
  readonly compileFingerprint: string;
  readonly compileVersion: string;
  readonly projectLabel: string;
  readonly organizationMembers: readonly { readonly memberId: string; readonly nodeId: string }[];
  readonly worldBindings: {
    readonly schema: "simfile.world-bindings.v1";
    readonly artifactPath: typeof WORLD_BINDINGS_IMAGE_PATH;
    readonly digest: string;
    readonly assignments: readonly { readonly memberId: string; readonly nodeId: string }[];
  } | null;
  readonly networks: readonly {
    readonly id: string;
    readonly mode: "external" | "managed";
    readonly internalPort: number | null;
    readonly rooms: readonly { readonly id: string; readonly members: readonly string[] }[];
    readonly nodes: readonly {
      readonly nodeId: string;
      readonly memberId: string;
      readonly configPath: string;
      readonly sha256: string;
    }[];
  }[];
  readonly hasExternalMoltnet: boolean;
}

export interface CreateOrganizationReadinessEvidenceInput {
  compileVersion: string;
  containerArtifacts: GeneratedContainerArtifacts;
  moltnetArtifacts: MoltnetArtifacts | null;
  plan: CompilePlan;
  worldBindings?: ResolvedWorldBindings;
}

const fail = (message: string): never => {
  throw new SpawnfileError("compile_error", `organization readiness evidence is inconsistent: ${message}`);
};

const sha256 = (content: string): string =>
  `sha256:${createHash("sha256").update(content).digest("hex")}`;

const compareAscii = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const sort = <T>(values: readonly T[], key: (value: T) => string): T[] =>
  [...values].sort((left, right) => compareAscii(key(left), key(right)));

const assertUnique = <T>(values: readonly T[], key: (value: T) => string, label: string): void => {
  const seen = new Set<string>();
  for (const value of values) {
    const valueKey = key(value);
    if (seen.has(valueKey)) fail(`duplicate ${label}: ${valueKey}`);
    seen.add(valueKey);
  }
};

const freeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value && typeof value === "object") {
    if (seen.has(value)) return value;
    seen.add(value);
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child, seen);
  }
  return value;
};

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const MEMBER_ID = new RegExp(ORGANIZATION_MEMBER_ID_PATTERN_SOURCE, "u");
const FINGERPRINT = /^sf1:[a-f0-9]{12}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const CONFIG_PATH = /^\/var\/lib\/spawnfile\/moltnet\/nodes\/[A-Za-z0-9_.-]+\.json$/u;

const nodeByMember = (plan: CompilePlan): Map<string, string> => {
  const members = plan.organizationIdentity?.agentMembers ?? [];
  if (members.length > MAX_ORGANIZATION_AGENT_MEMBERS) fail("organization member cardinality exceeds bounds");
  assertUnique(members, (member) => member.memberId, "organization member");
  const result = new Map<string, string>();
  for (const node of plan.nodes) {
    if (node.kind !== "agent") continue;
    assertId(node.id, "organization node id");
    const memberId = resolveCanonicalAgentMemberId(plan, node.value.source);
    if (!memberId) continue;
    if (!members.some((member) => member.memberId === memberId) || result.has(memberId)) {
      fail(`organization member ${memberId} does not resolve to exactly one node`);
    }
    result.set(memberId, node.id);
  }
  if (result.size !== members.length) fail("organization member cardinality mismatch");
  return result;
};

const emittedConfigContent = (
  artifacts: MoltnetArtifacts,
  configPath: string
): string => {
  const emittedPath = `container/rootfs${configPath}`;
  const matches = artifacts.files.filter((file) => file.path === emittedPath);
  if (matches.length !== 1) fail(`node config ${configPath} is not emitted exactly once`);
  return matches[0]!.content;
};

const attachmentRecords = (plan: CompilePlan): Array<{
  memberId: string;
  networkId: string;
  nodeId: string;
  rooms: readonly string[];
}> => {
  const records: Array<{ memberId: string; networkId: string; nodeId: string; rooms: readonly string[] }> = [];
  for (const node of plan.nodes) {
    if (node.kind !== "agent") continue;
    const agent = node.value as ResolvedAgentNode;
    for (const attachment of agent.surfaces?.moltnet ?? []) {
      const memberId = attachment.memberId ?? fail(`Moltnet attachment on ${node.id} has no member`);
      assertId(attachment.network, "Moltnet attachment network id");
      assertMemberId(memberId, "Moltnet attachment member id");
      records.push({
        memberId,
        networkId: attachment.network,
        nodeId: node.id,
        rooms: Object.keys(attachment.rooms ?? {})
      });
    }
  }
  assertUnique(records, (record) => `${record.networkId}\u0000${record.memberId}`, "Moltnet attachment member");
  assertUnique(records, (record) => `${record.networkId}\u0000${record.nodeId}`, "Moltnet attachment node");
  return records;
};

const assertId = (value: string, label: string): void => {
  if (!ID.test(value)) {
    fail(`${label} is unbounded or noncanonical`);
  }
};

const assertMemberId = (value: string, label: string): void => {
  if (!MEMBER_ID.test(value)) fail(`${label} is unbounded or noncanonical`);
};

const assertConfigPath = (value: string): void => {
  if (value.length > 255 || !CONFIG_PATH.test(value)) {
    fail(`Moltnet config path is noncanonical: ${value}`);
  }
};

const validateMoltnet = (
  artifacts: MoltnetArtifacts | null,
  plan: CompilePlan
): OrganizationReadinessEvidence["networks"] => {
  const servers = artifacts?.serverPlans ?? [];
  const nodePlans = artifacts?.nodePlans ?? [];
  const attachments = attachmentRecords(plan);
  assertUnique(servers, (server) => server.networkId, "Moltnet network");
  assertUnique(servers, (server) => server.id, "Moltnet server");
  assertUnique(nodePlans, (node) => node.configPath, "Moltnet node config");
  assertUnique(nodePlans, (node) => `${node.networkId}\u0000${node.memberId ?? ""}`, "Moltnet node member");
  if (!artifacts && attachments.length > 0) fail("Moltnet attachments exist without artifacts");
  if (servers.length > MAX_ORGANIZATION_AGENT_MEMBERS || nodePlans.length > MAX_ORGANIZATION_AGENT_MEMBERS
    || attachments.length > MAX_ORGANIZATION_AGENT_MEMBERS) fail("Moltnet topology exceeds organization bounds");

  const serverByNetwork = new Map(servers.map((server) => [server.networkId, server]));
  const attachmentByKey = new Map(attachments.map((attachment) => [
    `${attachment.networkId}\u0000${attachment.memberId}`, attachment
  ]));
  const nodeByKey = new Map(nodePlans.map((node) => [
    `${node.networkId}\u0000${node.memberId ?? ""}`, node
  ]));
  for (const attachment of attachments) {
    const server = serverByNetwork.get(attachment.networkId)
      ?? fail(`Moltnet attachment references nonexistent network ${attachment.networkId}`);
    const rooms = new Map(server.rooms.map((room) => [room.id, room]));
    for (const roomId of attachment.rooms) {
      const room = rooms.get(roomId);
      if (!room || !room.members.includes(attachment.memberId)) {
        fail(`Moltnet attachment room ${attachment.networkId}/${roomId} lacks ${attachment.memberId}`);
      }
    }
    if (!nodeByKey.has(`${attachment.networkId}\u0000${attachment.memberId}`)) {
      fail(`Moltnet attachment ${attachment.networkId}/${attachment.memberId} has no node plan`);
    }
  }
  for (const node of nodePlans) {
    const memberId = node.memberId ?? fail(`Moltnet node ${node.configPath} has no member`);
    assertConfigPath(node.configPath);
    assertId(node.networkId, "Moltnet node network id");
    assertMemberId(memberId, "Moltnet node member id");
    if (!serverByNetwork.has(node.networkId)) fail(`Moltnet node references nonexistent network ${node.networkId}`);
    if (!attachmentByKey.has(`${node.networkId}\u0000${node.memberId}`)) {
      fail(`Moltnet node ${node.networkId}/${node.memberId} has no attachment`);
    }
    emittedConfigContent(artifacts as MoltnetArtifacts, node.configPath);
  }
  for (const membership of plan.moltnetRoomMemberships ?? []) {
    const server = serverByNetwork.get(membership.networkId);
    const room = server?.rooms.filter((candidate) => candidate.id === membership.roomId);
    if (!server || room?.length !== 1 || !room[0]!.members.includes(membership.concreteMemberId)) {
      fail(`Moltnet room membership ${membership.networkId}/${membership.roomId} lacks ${membership.concreteMemberId}`);
    }
    const attachment = attachmentByKey.get(`${membership.networkId}\u0000${membership.concreteMemberId}`);
    if (!attachment || attachment.nodeId === "" || !attachment.rooms.includes(membership.roomId)) {
      fail(`Moltnet room membership has no concrete attachment`);
    }
  }

  return sort(servers.map((server) => {
    assertId(server.networkId, "Moltnet network id");
    assertId(server.id, "Moltnet server id");
    if (server.mode === "managed" && (!Number.isInteger(server.port) || server.port! < 1 || server.port! > 65535)) {
      fail(`Moltnet managed port is invalid for ${server.networkId}`);
    }
    const rooms = sort(server.rooms.map((room) => {
      assertId(room.id, "Moltnet room id");
      assertUnique(room.members, (member) => member, `Moltnet room member on ${server.networkId}/${room.id}`);
      for (const member of room.members) assertMemberId(member, `Moltnet room member on ${server.networkId}/${room.id}`);
      return { id: room.id, members: sort(room.members, (member) => member) };
    }), (room) => room.id);
    assertUnique(rooms, (room) => room.id, `Moltnet room on ${server.networkId}`);
    const nodes = sort(nodePlans.filter((node) => node.networkId === server.networkId).map((node) => {
      const attachment = attachmentByKey.get(`${node.networkId}\u0000${node.memberId}`)!;
      return { configPath: node.configPath, memberId: node.memberId!, nodeId: attachment.nodeId,
        sha256: sha256(emittedConfigContent(artifacts as MoltnetArtifacts, node.configPath)) };
    }), (node) => `${node.memberId}\u0000${node.nodeId}`);
    return { id: server.networkId, internalPort: server.mode === "managed" ? server.port! : null,
      mode: server.mode, nodes, rooms };
  }), (network) => network.id);
};

export const createOrganizationReadinessEvidence = (
  input: CreateOrganizationReadinessEvidenceInput
): OrganizationReadinessEvidence => {
  const { containerArtifacts, moltnetArtifacts, plan, worldBindings } = input;
  const distribution = containerArtifacts.distribution.report;
  if (input.compileVersion !== "0.1") fail("compile version is invalid");
  const { compile_fingerprint: fingerprint, generated_at: _generatedAt, ...distributionBody } = distribution;
  if (!FINGERPRINT.test(fingerprint) || containerArtifacts.distribution.fingerprint !== fingerprint
    || createDistributionFingerprint(distributionBody) !== fingerprint) {
    fail("compile fingerprint disagrees with canonical distribution report");
  }
  const memberNodes = nodeByMember(plan);
  const organizationMembers = sort(
    [...memberNodes.entries()].map(([memberId, nodeId]) => ({ memberId, nodeId })),
    (member) => member.memberId
  );
  assertUnique(organizationMembers, (member) => member.nodeId, "organization node assignment");
  for (const member of organizationMembers) {
    assertMemberId(member.memberId, "organization member id");
    assertId(member.nodeId, "organization node id");
  }

  const worldBindingEvidence = distribution.world_bindings;
  let projectedWorldBindings: OrganizationReadinessEvidence["worldBindings"] = null;
  if (worldBindings) {
    const distributionBinding = worldBindingEvidence
      ?? fail("distribution world-binding evidence is missing or incompatible");
    if (distributionBinding.artifact_path !== WORLD_BINDINGS_IMAGE_PATH
      || distributionBinding.schema !== "simfile.world-bindings.v1") {
      fail("distribution world-binding evidence is missing or incompatible");
    }
    const digest = sha256(worldBindings.canonicalBytes);
    if (!DIGEST.test(distributionBinding.digest) || distributionBinding.digest !== digest) {
      fail("distribution world-binding digest disagrees with resolved bindings");
    }
    const assignments = sort(worldBindings.assignments.map((assignment) => ({
      memberId: assignment.binding.member.id,
      nodeId: assignment.nodeId
    })), (assignment) => assignment.memberId);
    assertUnique(assignments, (assignment) => assignment.memberId, "world-binding member");
    assertUnique(assignments, (assignment) => assignment.nodeId, "world-binding node");
    for (const assignment of assignments) {
      assertMemberId(assignment.memberId, "world-binding member id");
      assertId(assignment.nodeId, "world-binding node id");
    }
    if (assignments.length !== organizationMembers.length
      || assignments.some((assignment, index) => assignment.memberId !== organizationMembers[index]?.memberId
        || assignment.nodeId !== organizationMembers[index]?.nodeId)) {
      fail("world-binding assignments disagree with resolved organization members");
    }
    projectedWorldBindings = {
      artifactPath: WORLD_BINDINGS_IMAGE_PATH,
      assignments,
      digest,
      schema: "simfile.world-bindings.v1"
    };
  } else if (worldBindingEvidence) {
    fail("distribution contains world-binding evidence without resolved bindings");
  }

  const networks = validateMoltnet(moltnetArtifacts, plan);
  const distributionNetworks = sort(distribution.moltnet.networks, (network) => network.id);
  assertUnique(distributionNetworks, (network) => network.id, "distribution Moltnet network");
  if (distributionNetworks.length !== networks.length || networks.some((network, index) => {
    const distributionNetwork = distributionNetworks[index];
    return distributionNetwork?.id !== network.id || distributionNetwork.server_mode !== network.mode;
  })) {
    fail("distribution Moltnet networks disagree with emitted topology");
  }
  const projectLabel = normalizeProjectLabelSlug(distribution.organization.project);
  if (projectLabel.length > 128 || !ID.test(projectLabel)) fail("project label is unbounded or noncanonical");

  return freeze({
    compileFingerprint: fingerprint,
    compileVersion: input.compileVersion,
    hasExternalMoltnet: networks.some((network) => network.mode === "external"),
    networks,
    organizationMembers,
    projectLabel,
    version: ORGANIZATION_READINESS_EVIDENCE_VERSION,
    worldBindings: projectedWorldBindings
  });
};
