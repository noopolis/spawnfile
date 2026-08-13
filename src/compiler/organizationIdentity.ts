import { SpawnfileError } from "../shared/index.js";
import type { CompilePlan, MoltnetExternalParticipantIntent, ResolvedAgentNode, ResolvedTeamNode } from "./types.js";
import type { TeamNetworkServer } from "../manifest/index.js";

export const ORGANIZATION_ID_SEGMENT_PATTERN_SOURCE = "^[a-z][a-z0-9-]{0,62}$";
export const ORGANIZATION_MEMBER_ID_PATTERN_SOURCE = "^[a-z][a-z0-9-]{0,62}(\\.[a-z][a-z0-9-]{0,62}){0,7}$";
export const MAX_ORGANIZATION_MEMBER_DEPTH = 8;
export const MAX_ORGANIZATION_MEMBER_ID_BYTES = 255;
export const MAX_ORGANIZATION_AGENT_MEMBERS = 128;
export const MAX_EXTERNAL_PARTICIPANTS = 32;

const segment = new RegExp(ORGANIZATION_ID_SEGMENT_PATTERN_SOURCE, "u");
const memberIdPattern = new RegExp(ORGANIZATION_MEMBER_ID_PATTERN_SOURCE, "u");
const fail = (message: string): never => { throw new SpawnfileError("validation_error", message); };
const required = <T>(value: T, message: string): NonNullable<T> => value == null ? fail(message) : value as NonNullable<T>;
const assertSegment = (value: string, label: string): void => {
  if (!segment.test(value)) fail(`${label} must match ${ORGANIZATION_ID_SEGMENT_PATTERN_SOURCE}`);
};
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
};
const byAscii = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const exact = (actual: readonly string[] | undefined, expected: readonly string[]): boolean =>
  actual?.length === expected.length && actual.every((value, index) => value === expected[index]);

export interface ResolvedOrganizationAgentMember {
  readonly authoredMemberKey: string;
  readonly kind: "agent";
  readonly memberId: string;
  readonly principalId: string;
}
export interface ResolvedExternalParticipant {
  readonly authoredParticipantKey: string;
  readonly kind: "service";
  readonly memberId: string;
  readonly principalId: string;
}
export interface ResolvedOrganizationIdentity {
  readonly agentMembers: readonly ResolvedOrganizationAgentMember[];
  readonly externalParticipants: readonly ResolvedExternalParticipant[];
}

const teamNodes = (plan: CompilePlan): Map<string, ResolvedTeamNode> => new Map(
  plan.nodes.filter((node) => node.kind === "team").map((node) => [node.value.source, node.value as ResolvedTeamNode])
);

const rootTeam = (plan: CompilePlan): ResolvedTeamNode | undefined => {
  const node = plan.nodes.find((entry) => entry.id === plan.root || entry.value.source === plan.root);
  return node?.value.kind === "team" ? node.value : undefined;
};

const pathsToAgents = (plan: CompilePlan): Map<string, string[]> => {
  const teams = teamNodes(plan);
  const edges = plan.edges.filter((edge) => edge.kind === "team_member");
  const paths = new Map<string, string[]>();
  const teamPaths = new Map<string, string[]>();
  const visitedNodeIds = new Set<string>();
  const walk = (source: string, prefix: string[], seen: Set<string>): void => {
    if (seen.has(source)) fail(`organization member graph cycle at ${source}`);
    const team = teams.get(source);
    if (!team) return;
    const priorTeamPath = teamPaths.get(source);
    if (priorTeamPath) fail(`team is reached through multiple organization paths: ${source}`);
    teamPaths.set(source, prefix);
    const node = plan.nodes.find((entry) => entry.value.source === source);
    if (!node || node.kind !== "team") return fail(`organization graph references missing team ${source}`);
    const resolvedNode = node;
    visitedNodeIds.add(resolvedNode.id);
    const outgoing = edges
      .filter((entry) => entry.from === resolvedNode.id)
      .sort((left, right) => byAscii(left.label, right.label));
    const memberSlots = new Set(team.members.map((member) => member.id));
    if (memberSlots.size !== team.members.length || outgoing.length !== team.members.length) {
      fail(`organization graph cardinality mismatch for team ${team.name}`);
    }
    const localSlots = new Set<string>();
    for (const edge of outgoing) {
      if (localSlots.has(edge.label)) fail(`duplicate organization member slot: ${edge.label}`);
      localSlots.add(edge.label);
      assertSegment(edge.label, "organization member slot");
      const next = [...prefix, edge.label];
      if (next.length > MAX_ORGANIZATION_MEMBER_DEPTH) fail("organization member depth exceeds 8");
      const child = plan.nodes.find((node) => node.id === edge.to);
      if (!child) throw new SpawnfileError("validation_error", `organization graph references missing node ${edge.to}`);
      const resolvedChild = child;
      const member = team.members.find((entry) => entry.id === edge.label);
      if (!member || member.kind !== resolvedChild.kind || member.nodeSource !== resolvedChild.value.source) {
        fail(`organization graph member edge mismatch: ${edge.label}`);
      }
      if (resolvedChild.kind === "agent") {
        const previous = paths.get(resolvedChild.value.source);
        if (previous) fail(`agent source is reached through multiple organization paths: ${resolvedChild.value.source}`);
        paths.set(resolvedChild.value.source, next);
        visitedNodeIds.add(resolvedChild.id);
      } else walk(resolvedChild.value.source, next, new Set([...seen, source]));
    }
  };
  walk(plan.root, [], new Set());
  const rootNode = plan.nodes.find((node) => node.value.source === plan.root);
  const organizationNodeIds = new Set<string>(rootNode ? [rootNode.id] : []);
  for (const edge of edges) {
    organizationNodeIds.add(edge.from);
    organizationNodeIds.add(edge.to);
  }
  const extra = plan.nodes.find((node) =>
    organizationNodeIds.has(node.id) && !visitedNodeIds.has(node.id)
  );
  if (extra) fail(`unreachable organization graph node: ${extra.id}`);
  return paths;
};

export const resolveCanonicalAgentMemberId = (plan: CompilePlan, agentSource: string): string | undefined => {
  const identity = plan.organizationIdentity;
  if (!identity) return undefined;
  const path = pathsToAgents(plan).get(agentSource);
  return path?.join(".");
};

export const resolveOrganizationIdentity = (plan: CompilePlan): ResolvedOrganizationIdentity | undefined => {
  const root = rootTeam(plan);
  const declaredTeams = plan.nodes.filter((node) => node.kind === "team" && (node.value as ResolvedTeamNode).externalParticipants !== undefined);
  if (declaredTeams.some((node) => node.value.source !== root?.source)) {
    fail("external_participants may only be declared on the root team");
  }
  if (!root?.externalParticipants) return undefined;
  const paths = pathsToAgents(plan);
  const agents: ResolvedOrganizationAgentMember[] = [];
  const agentIds = new Set<string>();
  for (const node of plan.nodes.filter((entry) => entry.kind === "agent")) {
    const path = paths.get(node.value.source);
    if (!path) continue;
    if (path.length > MAX_ORGANIZATION_MEMBER_DEPTH) fail("organization member depth exceeds 8");
    path.forEach((part) => assertSegment(part, "organization member slot"));
    const memberId = path.join(".");
    if (!memberIdPattern.test(memberId) || Buffer.byteLength(memberId, "ascii") > MAX_ORGANIZATION_MEMBER_ID_BYTES) fail(`invalid organization member id: ${memberId}`);
    if (agentIds.has(memberId)) fail(`duplicate organization member id: ${memberId}`);
    agentIds.add(memberId);
    agents.push({ authoredMemberKey: path.at(-1) as string, kind: "agent", memberId, principalId: `agent:${memberId}` });
  }
  if (agents.length > MAX_ORGANIZATION_AGENT_MEMBERS) fail("organization has too many agent members");
  const seen = new Set<string>();
  const externalParticipants = root.externalParticipants.map((service) => {
    assertSegment(service.id, "external participant id");
    if (seen.has(service.id)) fail(`organization member collision: ${service.id}`);
    seen.add(service.id);
    return { authoredParticipantKey: service.id, kind: "service" as const, memberId: service.id, principalId: `system:${service.id}` };
  });
  for (const agent of agents) if (seen.has(agent.memberId)) fail(`organization member collision: ${agent.memberId}`);
  if (externalParticipants.length > MAX_EXTERNAL_PARTICIPANTS) fail("too many external participants");
  const result = { agentMembers: agents.sort((a, b) => byAscii(a.memberId, b.memberId)), externalParticipants: externalParticipants.sort((a, b) => byAscii(a.memberId, b.memberId)) };
  return freeze(structuredClone(result));
};

const actorTokenFor = (
  server: Extract<TeamNetworkServer, { mode: "managed" }>,
  tokenId: string,
  memberId: string,
  allowObserve = false
) => {
  const token = server.auth.tokens?.filter((entry) => entry.id === tokenId);
  if (token?.length !== 1) fail(`Moltnet actor token ${tokenId} must exist exactly once`);
  const selected = required(token?.[0], `Moltnet actor token ${tokenId} must exist exactly once`);
  const validScopes = exact(selected.scopes, ["attach", "write"])
    || allowObserve && exact(selected.scopes, ["attach", "observe", "write"]);
  if (!validScopes || !exact(selected.agents, [memberId])) {
    fail(`Moltnet actor token ${tokenId} has invalid scopes or agents for ${memberId}`);
  }
  return selected;
};

export const validateB31MoltnetAuth = (plan: CompilePlan): void => {
  const root = rootTeam(plan);
  if (!root?.externalParticipants) return;
  const identity = plan.organizationIdentity;
  const resolvedIdentity = required(identity, "B31 organization identity is missing");
  const paths = pathsToAgents(plan);
  const agentBySource = new Map(resolvedIdentity.agentMembers.map((member) => {
    const source = [...paths.entries()].find(([, path]) => path.join(".") === member.memberId)?.[0];
    return [source, member] as const;
  }));
  const networkIds = new Set(
    root.externalParticipants.flatMap((service) => service.surfaces.moltnet.map((attachment) => attachment.network))
  );
  for (const network of root.networks ?? []) {
    if (!root.externalParticipants.some((service) => service.surfaces.moltnet.some((attachment) => attachment.network === network.id))) continue;
    assertSegment(network.id, "B31 network id");
    if (network.server?.mode !== "managed" || network.server.auth.mode !== "bearer" || network.server.direct_messages !== true) {
      fail(`B31 network ${network.id} requires managed bearer direct_messages`);
    }
    const server = network.server;
    const managedServer = required(server, `B31 network ${network.id} requires a managed server`);
    if (JSON.stringify(managedServer.auth.client) !== JSON.stringify({ token_id: "operator" })) {
      fail(`B31 network ${network.id} requires auth.client token_id operator`);
    }
    const tokens = managedServer.auth.tokens ?? [];
    const operator = tokens.find((token) => token.id === "operator");
    if (tokens.filter((token) => token.id === "operator").length !== 1 || !operator || operator.agents !== undefined || !exact(operator.scopes, ["admin", "observe", "write"])) {
      fail(`B31 network ${network.id} has invalid operator token`);
    }
    const operatorSecret = operator?.secret;
    const usedTokenIds = new Set<string>();
    const usedEnvNames = new Set<string>();
    for (const token of tokens) {
      assertSegment(token.id, "Moltnet token id");
      if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(token.secret)) fail(`invalid Moltnet token env name ${token.secret}`);
      if (usedTokenIds.has(token.id) || usedEnvNames.has(token.secret)) fail(`duplicate Moltnet token identity ${token.id}`);
      usedTokenIds.add(token.id); usedEnvNames.add(token.secret);
      if (token.id !== "operator" && token.secret === operatorSecret) fail("operator and actor token env identities must differ");
    }
  }
  const selectedByNetwork = new Map<string, Map<string, string>>();
  const selectedActorKeys = new Set<string>();
  for (const member of resolvedIdentity.agentMembers) {
    const source = [...agentBySource.entries()].find(([, value]) => value.memberId === member.memberId)?.[0];
    const node = plan.nodes.find((entry) => entry.kind === "agent" && (entry.value as ResolvedAgentNode).source === source);
    const attachments = (node?.value as ResolvedAgentNode | undefined)?.surfaces?.moltnet ?? [];
    for (const attachment of attachments.filter((entry) => networkIds.has(entry.network))) {
      const network = root.networks?.find((entry) => entry.id === attachment.network);
      const selectedTokenId = required(attachment.auth?.tokenId, `B31 agent ${member.memberId} must select auth.token_id`);
      const actorKey = `${attachment.network}\u0000${member.memberId}`;
      if (selectedActorKeys.has(actorKey)) fail(`B31 actor ${member.memberId} selects more than one token on ${attachment.network}`);
      selectedActorKeys.add(actorKey);
      if (network?.server?.mode === "managed") {
        const token = actorTokenFor(network.server, selectedTokenId, member.memberId);
        const selected = selectedByNetwork.get(attachment.network) ?? new Map<string, string>();
        const previous = selected.get(selectedTokenId);
        if (previous) fail(`Moltnet actor token ${selectedTokenId} is shared by ${previous} and ${member.memberId}`);
        selected.set(selectedTokenId, member.memberId);
        selectedByNetwork.set(attachment.network, selected);
        if (token.id === "operator") fail(`B31 actor ${member.memberId} must not use operator token`);
      }
    }
  }
  for (const service of root.externalParticipants) {
    for (const attachment of service.surfaces.moltnet) {
      const network = root.networks?.find((entry) => entry.id === attachment.network);
      if (network?.server?.mode !== "managed") continue;
      const token = actorTokenFor(network.server, attachment.auth.token_id, service.id, true);
      if (token.id === "operator") fail(`B31 external participant ${service.id} must not use operator token`);
      const selected = selectedByNetwork.get(attachment.network) ?? new Map<string, string>();
      const previous = selected.get(token.id);
      if (previous) fail(`Moltnet actor token ${token.id} is shared by ${previous} and ${service.id}`);
      selected.set(token.id, service.id);
      selectedByNetwork.set(attachment.network, selected);
    }
  }
  for (const network of root.networks ?? []) {
    const selected = selectedByNetwork.get(network.id);
    if (network.server?.mode === "managed" && selected) {
      for (const token of network.server.auth.tokens ?? []) {
        if (token.id !== "operator" && !selected.has(token.id)) {
          fail(`Moltnet actor token ${token.id} is not selected by exactly one actor`);
        }
      }
    }
  }
};

export const resolveMoltnetExternalParticipantIntents = (plan: CompilePlan): MoltnetExternalParticipantIntent[] => {
  const identity = plan.organizationIdentity;
  const root = rootTeam(plan);
  if (!identity || !root?.externalParticipants) return [];
  const paths = pathsToAgents(plan);
  const agents = new Map(identity.agentMembers.map((member) => [member.memberId, member]));
  const networkIds = new Set((root.networks ?? []).map((network) => network.id));
  const result: MoltnetExternalParticipantIntent[] = [];
  for (const service of root.externalParticipants) {
    const participant = identity.externalParticipants.find((entry) => entry.memberId === service.id);
    if (!participant) throw new SpawnfileError("validation_error", `missing external participant identity: ${service.id}`);
    const resolvedParticipant = participant;
    for (const attachment of service.surfaces.moltnet) {
      if (!networkIds.has(attachment.network)) fail(`external participant ${service.id} references unknown network ${attachment.network}`);
      const peers: string[] = [];
      for (const [memberId, agent] of agents) {
        const node = plan.nodes.find((entry) => entry.kind === "agent" && paths.get(entry.value.source)?.join(".") === memberId);
        const authored = (node?.value as ResolvedAgentNode | undefined)?.surfaces?.moltnet ?? [];
        const eligible = authored.filter((entry) => entry.network === attachment.network && entry.dms?.enabled === true);
        if (eligible.length > 1) fail(`duplicate eligible Moltnet peer for ${service.id}/${attachment.network}`);
        if (eligible.length === 1) peers.push(agent.memberId);
      }
      if (new Set(peers).size !== peers.length) fail(`duplicate eligible Moltnet peer for ${service.id}/${attachment.network}`);
      if (peers.length === 0) fail(`external participant ${service.id}/${attachment.network} has no eligible direct-message peers`);
      peers.sort(byAscii);
      const network = root.networks?.find((entry) => entry.id === attachment.network);
      const token = network?.server?.mode === "managed" ? actorTokenFor(network.server, attachment.auth.token_id, service.id, true) : undefined;
      result.push({ participant: resolvedParticipant, networkId: attachment.network, tokenId: attachment.auth.token_id, tokenEnv: token?.secret ?? "", directMessagePeers: peers });
    }
  }
  return result;
};
