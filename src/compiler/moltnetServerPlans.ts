import { SpawnfileError } from "../shared/index.js";

import {
  createMoltnetServerConfigPath,
  resolveMoltnetBaseUrl
} from "./moltnetConfigLowering.js";
import type { MoltnetServerPlan } from "./moltnetArtifactTypes.js";
import { listConcreteMoltnetRoomMemberIds } from "./moltnetRoomMemberships.js";
import {
  assertCompatibleMoltnetNetworkName,
  assertCompatibleMoltnetRoomPolicy,
  assertCompatibleMoltnetServer
} from "./moltnetRoomPolicyCompatibility.js";
import { resolveNetworkPort, toContainerRootfsPath } from "./moltnetArtifactPaths.js";
import type { CompilePlan, ResolvedTeamNetwork, ResolvedTeamNode } from "./types.js";

const DEFAULT_MOLTNET_PORT = 8787;

interface TeamPlanNode {
  id: string;
  slug: string;
  value: ResolvedTeamNode;
}

interface NetworkDeclaration {
  network: ResolvedTeamNetwork;
  team: TeamPlanNode;
}

const orderedDeclarations = (teamNodes: readonly TeamPlanNode[]): NetworkDeclaration[] =>
  [...teamNodes]
    .sort((left, right) => left.value.source.localeCompare(right.value.source))
    .flatMap((team) => [...(team.value.networks ?? [])]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((network) => ({ network, team })));

const organizationTeamIds = (plan: CompilePlan): Set<string> => {
  const root = plan.nodes.find((node) =>
    node.kind === "team" && node.value.source === plan.root
  );
  if (!root) return new Set();
  const ids = new Set([root.id]);
  const pending = [root.id];
  while (pending.length > 0) {
    const parent = pending.shift();
    for (const edge of plan.edges.filter((entry) =>
      entry.kind === "team_member" && entry.from === parent
    )) {
      const child = plan.nodes.find((node) => node.id === edge.to);
      if (!child || child.kind !== "team" || ids.has(child.id)) continue;
      ids.add(child.id);
      pending.push(child.id);
    }
  }
  return ids;
};

const assertCompatibleOwner = (
  existing: MoltnetServerPlan,
  declaration: NetworkDeclaration
): void => {
  const { network } = declaration;
  const server = network.server;
  if (!server) return;
  if (existing.baseUrl !== resolveMoltnetBaseUrl(server)) {
    throw new SpawnfileError(
      "validation_error",
      `Duplicate Moltnet network ${network.id} declares conflicting server URL`
    );
  }
  assertCompatibleMoltnetNetworkName(network.id, existing.name, network.name);
  assertCompatibleMoltnetServer(network.id, existing.server, server);
};

const createOwnedPlan = (
  declaration: NetworkDeclaration,
  fallbackPort: number
): MoltnetServerPlan => {
  const { network, team } = declaration;
  const server = network.server;
  if (!server) {
    throw new SpawnfileError(
      "validation_error",
      `Moltnet network ${network.id} must declare server`
    );
  }
  const port = server.mode === "managed"
    ? resolveNetworkPort(network, fallbackPort)
    : undefined;
  const serverId = `${team.slug}-${network.id}`;
  return {
    baseUrl: resolveMoltnetBaseUrl(server),
    ...(server.mode === "managed"
      ? { configPath: toContainerRootfsPath(createMoltnetServerConfigPath(serverId)) }
      : {}),
    id: serverId,
    mode: server.mode,
    name: network.name,
    networkId: network.id,
    ...(port ? { port } : {}),
    rooms: [],
    server,
    secretPatches: [],
    teamSource: team.value.source
  };
};

const mergeRooms = (
  plan: CompilePlan,
  serverPlan: MoltnetServerPlan,
  declaration: NetworkDeclaration
): void => {
  const { network, team } = declaration;
  for (const room of network.rooms) {
    const concreteMembers = listConcreteMoltnetRoomMemberIds(
      plan,
      team.value,
      network.id,
      room
    );
    const existingRoom = serverPlan.rooms.find((entry) => entry.id === room.id);
    if (!existingRoom) {
      serverPlan.rooms.push({
        ...(room.federation ? { federation: room.federation } : {}),
        id: room.id,
        members: concreteMembers,
        ...(room.name ? { name: room.name } : {}),
        ...(room.visibility ? { visibility: room.visibility } : {}),
        ...(room.write_policy ? { write_policy: room.write_policy } : {})
      });
      continue;
    }
    existingRoom.members = [
      ...new Set([...existingRoom.members, ...concreteMembers])
    ].sort();
    assertCompatibleMoltnetRoomPolicy(
      network.id,
      room.id,
      "federation",
      existingRoom.federation,
      room.federation
    );
    assertCompatibleMoltnetRoomPolicy(
      network.id,
      room.id,
      "visibility",
      existingRoom.visibility,
      room.visibility
    );
    assertCompatibleMoltnetRoomPolicy(
      network.id,
      room.id,
      "write_policy",
      existingRoom.write_policy,
      room.write_policy
    );
    existingRoom.federation ??= room.federation;
    existingRoom.visibility ??= room.visibility;
    existingRoom.write_policy ??= room.write_policy;
  }
};

export const resolveMoltnetServerPlans = (
  plan: CompilePlan,
  teamNodes: readonly TeamPlanNode[]
): Map<string, MoltnetServerPlan> => {
  const organizationIds = plan.organizationIdentity
    ? organizationTeamIds(plan)
    : undefined;
  const declarations = orderedDeclarations(
    organizationIds
      ? teamNodes.filter((team) => organizationIds.has(team.id))
      : teamNodes
  );
  const ownerlessRoot = declarations.find((declaration) =>
    declaration.team.value.source === plan.root && !declaration.network.server
  );
  if (ownerlessRoot) {
    throw new SpawnfileError(
      "validation_error",
      `Root Moltnet network ${ownerlessRoot.network.id} must declare a server owner`
    );
  }
  const serverPlans = new Map<string, MoltnetServerPlan>();
  let nextPort = DEFAULT_MOLTNET_PORT;

  for (const declaration of declarations) {
    if (!declaration.network.server) continue;
    const existing = serverPlans.get(declaration.network.id);
    if (existing) {
      assertCompatibleOwner(existing, declaration);
      continue;
    }
    const serverPlan = createOwnedPlan(declaration, nextPort);
    serverPlans.set(declaration.network.id, serverPlan);
    if (serverPlan.port) nextPort = Math.max(nextPort, serverPlan.port + 1);
  }

  const declarationCounts = new Map<string, number>();
  for (const declaration of declarations) {
    const networkId = declaration.network.id;
    const serverPlan = serverPlans.get(networkId);
    if (!serverPlan) {
      throw new SpawnfileError(
        "validation_error",
        `Moltnet network ${networkId} must resolve to at least one server owner`
      );
    }
    declarationCounts.set(networkId, (declarationCounts.get(networkId) ?? 0) + 1);
    mergeRooms(plan, serverPlan, declaration);
  }

  for (const [networkId, count] of declarationCounts) {
    if (count > 1) serverPlans.get(networkId)?.rooms.sort((left, right) =>
      left.id.localeCompare(right.id)
    );
  }
  for (const serverPlan of serverPlans.values()) {
    const pairingIds = new Set(
      serverPlan.server.mode === "managed"
        ? (serverPlan.server.pairings ?? []).map((pairing) => pairing.id)
        : []
    );
    for (const room of serverPlan.rooms) {
      if (serverPlan.server.mode === "external" && room.federation !== undefined) {
        throw new SpawnfileError(
          "validation_error",
          `External Moltnet network ${serverPlan.networkId} room ${room.id} cannot declare federation`
        );
      }
      if (!Array.isArray(room.federation)) continue;
      const unknownPairing = room.federation.find((pairingId) => !pairingIds.has(pairingId));
      if (unknownPairing) {
        throw new SpawnfileError(
          "validation_error",
          `Moltnet network ${serverPlan.networkId} room ${room.id} federation references unknown pairing ${unknownPairing}`
        );
      }
    }
  }
  return serverPlans;
};
