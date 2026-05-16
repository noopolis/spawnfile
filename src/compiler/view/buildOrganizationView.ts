import path from "node:path";

import { SpawnfileError } from "../../shared/index.js";

import { buildCompilePlan } from "../buildCompilePlan.js";
import { resolveMoltnetRoomMemberships } from "../moltnetRoomMemberships.js";
import type {
  CompilePlan,
  CompilePlanEdge,
  CompilePlanNode,
  ResolvedMoltnetRoomMembership,
  ResolvedTeamNetwork,
  ResolvedTeamNode
} from "../types.js";
import type {
  OrganizationNetworkMemberView,
  OrganizationNetworkDeclarationView,
  OrganizationNetworkView,
  OrganizationTreeNetworkSummary,
  OrganizationView,
  OrganizationViewTreeNode
} from "./types.js";

const createNameCounts = (plan: CompilePlan): Map<string, number> => {
  const counts = new Map<string, number>();

  for (const node of plan.nodes) {
    const key = `${node.kind}:${node.value.name}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return counts;
};

const formatDisplayName = (
  node: CompilePlanNode,
  nameCounts: Map<string, number>
): string => {
  const key = `${node.kind}:${node.value.name}`;
  return (nameCounts.get(key) ?? 0) > 1
    ? `${node.value.name} [${node.id}]`
    : node.value.name;
};

const groupEdgesBySource = (
  edges: CompilePlanEdge[]
): Map<string, CompilePlanEdge[]> => {
  const groups = new Map<string, CompilePlanEdge[]>();

  for (const edge of edges) {
    const group = groups.get(edge.from) ?? [];
    group.push(edge);
    groups.set(edge.from, group);
  }

  return groups;
};

const buildTreeNetworkSummaries = (
  node: CompilePlanNode
): OrganizationTreeNetworkSummary[] => {
  if (node.value.kind !== "team") {
    return [];
  }

  return (node.value.networks ?? []).map((network) => ({
    authMode: network.server?.auth.mode,
    debugEvents: network.server?.mode === "managed" ? network.server.debug_events : undefined,
    directMessages: network.server?.mode === "managed" ? network.server.direct_messages : undefined,
    expose: network.server?.mode === "managed" ? network.server.human_ingress : undefined,
    httpEnabled: network.server?.mode === "managed" ? network.server.human_ingress === true : false,
    id: network.id,
    name: network.name,
    provider: network.provider,
    serverMode: network.server?.mode,
    url: network.server?.url,
    rooms: network.rooms.map((room) => ({
      declaredMembers: [...room.members],
      id: room.id
    }))
  }));
};

const buildTreeNode = (
  node: CompilePlanNode,
  nodeById: Map<string, CompilePlanNode>,
  edgesBySource: Map<string, CompilePlanEdge[]>,
  nameCounts: Map<string, number>,
  ancestors: string[] = []
): OrganizationViewTreeNode => {
  if (ancestors.includes(node.id)) {
    throw new SpawnfileError(
      "compile_error",
      `Cycle detected while building view tree for ${node.id}`
    );
  }

  const children = (edgesBySource.get(node.id) ?? []).map((edge) => {
    const child = nodeById.get(edge.to);
    if (!child) {
      throw new SpawnfileError(
        "compile_error",
        `Unable to find view node ${edge.to}`
      );
    }

    return {
      label: edge.label,
      node: buildTreeNode(
        child,
        nodeById,
        edgesBySource,
        nameCounts,
        [...ancestors, node.id]
      ),
      relation: edge.kind
    };
  });

  return {
    children,
    displayName: formatDisplayName(node, nameCounts),
    ...(node.value.kind === "team"
      ? {
          external: [...node.value.external],
          lead: node.value.lead,
          mode: node.value.mode
        }
      : {}),
    id: node.id,
    kind: node.kind,
    name: node.value.name,
    networks: buildTreeNetworkSummaries(node),
    runtimeName: node.runtimeName,
    source: node.value.source
  };
};

const sortNetworkMembers = (
  declaredMembers: string[],
  members: OrganizationNetworkMemberView[]
): OrganizationNetworkMemberView[] => {
  const declaredOrder = new Map(declaredMembers.map((member, index) => [member, index]));

  return [...members].sort((left, right) =>
    (declaredOrder.get(left.declaredSlot) ?? Number.MAX_SAFE_INTEGER)
    - (declaredOrder.get(right.declaredSlot) ?? Number.MAX_SAFE_INTEGER)
    || (left.representativePath ?? []).join("/").localeCompare(
      (right.representativePath ?? []).join("/")
    )
    || left.concreteMemberId.localeCompare(right.concreteMemberId)
  );
};

const toNetworkMemberView = (
  membership: ResolvedMoltnetRoomMembership
): OrganizationNetworkMemberView => ({
  agentName: membership.agentName,
  agentSource: membership.agentSource,
  concreteMemberId: membership.concreteMemberId,
  declaredSlot: membership.declaredSlot,
  directTeamName: membership.directTeamName,
  directTeamSource: membership.directTeamSource,
  ...(membership.policy ? { policy: { ...membership.policy } } : {}),
  ...(membership.representedSlot ? { representedSlot: membership.representedSlot } : {}),
  ...(membership.representedTeamName
    ? { representedTeamName: membership.representedTeamName }
    : {}),
  ...(membership.representedTeamSource
    ? { representedTeamSource: membership.representedTeamSource }
    : {}),
  ...(membership.representativePath
    ? { representativePath: [...membership.representativePath] }
    : {})
});

const createNetworkKey = (provider: string, networkId: string): string =>
  `${provider}::${networkId}`;

const buildNetworkDeclaration = (
  teamNode: ResolvedTeamNode,
  network: ResolvedTeamNetwork,
  roomMemberships: ResolvedMoltnetRoomMembership[]
): OrganizationNetworkDeclarationView => ({
  authMode: network.server?.auth.mode,
  debugEvents: network.server?.mode === "managed" ? network.server.debug_events : undefined,
  declaringTeamName: teamNode.name,
  declaringTeamSource: teamNode.source,
  directMessages: network.server?.mode === "managed" ? network.server.direct_messages : undefined,
  expose: network.server?.mode === "managed" ? network.server.human_ingress : undefined,
  httpEnabled: network.server?.mode === "managed" ? network.server.human_ingress === true : false,
  name: network.name,
  serverMode: network.server?.mode,
  url: network.server?.url,
  rooms: network.rooms.map((room) => {
    const members = roomMemberships
      .filter((membership) =>
        membership.declaringTeamSource === teamNode.source
        && membership.networkId === network.id
        && membership.roomId === room.id
      )
      .map(toNetworkMemberView);

    return {
      declaredMembers: [...room.members],
      id: room.id,
      members: sortNetworkMembers(room.members, members)
    };
  })
});

const buildNetworks = (
  plan: CompilePlan
): OrganizationNetworkView[] => {
  const roomMemberships = plan.moltnetRoomMemberships
    ?? resolveMoltnetRoomMemberships(plan);
  const groups = new Map<string, OrganizationNetworkView>();

  for (const node of plan.nodes) {
    if (node.value.kind !== "team") {
      continue;
    }

    const teamNode = node.value as ResolvedTeamNode;
    for (const network of teamNode.networks ?? []) {
      const key = createNetworkKey(network.provider, network.id);
      const declaration = buildNetworkDeclaration(teamNode, network, roomMemberships);

      const existing = groups.get(key);
      if (existing) {
        existing.declarations = [...(existing.declarations ?? []), declaration];
        continue;
      }

      groups.set(key, {
        declaringTeamName: declaration.declaringTeamName,
        declaringTeamSource: declaration.declaringTeamSource,
        declarations: [declaration],
        authMode: declaration.authMode,
        debugEvents: declaration.debugEvents,
        directMessages: declaration.directMessages,
        expose: declaration.expose,
        httpEnabled: declaration.httpEnabled,
        id: network.id,
        name: declaration.name,
        provider: network.provider,
        serverMode: declaration.serverMode,
        url: declaration.url,
        rooms: declaration.rooms
      });
    }
  }

  const networks = [...groups.values()];
  for (const network of networks) {
    const firstDeclaration = network.declarations?.[0];
    if (firstDeclaration) {
      network.declaringTeamName = firstDeclaration.declaringTeamName;
      network.declaringTeamSource = firstDeclaration.declaringTeamSource;
      network.authMode = firstDeclaration.authMode;
      network.directMessages = firstDeclaration.directMessages;
      network.expose = firstDeclaration.expose;
      network.httpEnabled = firstDeclaration.httpEnabled;
      network.name = firstDeclaration.name;
      network.serverMode = firstDeclaration.serverMode;
      network.url = firstDeclaration.url;
      network.rooms = firstDeclaration.rooms;
    }
  }

  return networks;
};

export const buildOrganizationView = async (
  inputPath: string
): Promise<OrganizationView> => {
  const plan = await buildCompilePlan(inputPath);
  const rootNode = plan.nodes.find((node) => node.value.source === plan.root);
  if (!rootNode) {
    throw new SpawnfileError(
      "compile_error",
      `Unable to find root view node for ${plan.root}`
    );
  }

  const nodeById = new Map(plan.nodes.map((node) => [node.id, node]));
  const root = buildTreeNode(
    rootNode,
    nodeById,
    groupEdgesBySource(plan.edges),
    createNameCounts(plan)
  );

  return {
    contexts: [],
    diagnostics: [],
    inputPath,
    networks: buildNetworks(plan),
    projectRoot: path.dirname(plan.root),
    root,
    runtimes: []
  };
};
