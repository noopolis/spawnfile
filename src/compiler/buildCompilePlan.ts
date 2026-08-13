import {
  getCanonicalManifestPath,
  getManifestPath
} from "../filesystem/index.js";
import {
  loadManifest,
  isAgentManifest,
  type LoadedManifest
} from "../manifest/index.js";
import { assignStableNodeIds } from "./helpers.js";
import { CompilePlan, CompilePlanEdge, CompilePlanNode, ResolvedTeamMembershipContext } from "./types.js";
import { resolvePlanMoltnetAttachments } from "./moltnetResolution.js";
import { resolvePlanMemoryAccess } from "./memoryResolution.js";
import { resolveMoltnetRoomMemberships } from "./moltnetRoomMemberships.js";
import { createRuntimeGroups } from "./buildCompilePlanRuntime.js";
import { validateAllowedWakeSenders } from "./moltnetAllowedWakeSendersValidation.js";
import {
  createCompilePlanTraversal,
  type InternalNode
} from "./buildCompilePlanTraversal.js";
import { resolveMoltnetExternalParticipantIntents, resolveOrganizationIdentity, validateB31MoltnetAuth } from "./organizationIdentity.js";

export const buildCompilePlan = async (inputPath: string): Promise<CompilePlan> => {
  const rootManifestPath = getCanonicalManifestPath(getManifestPath(inputPath));
  const loadCache = new Map<string, Promise<LoadedManifest>>();
  const nodeCache = new Map<string, InternalNode>();
  const fingerprintCache = new Map<string, string>();
  const edges: CompilePlanEdge[] = [];
  const memberships = new Map<string, ResolvedTeamMembershipContext>();

  const getLoadedManifest = (manifestPath: string): Promise<LoadedManifest> => {
    const canonicalPath = getCanonicalManifestPath(manifestPath);
    const cached = loadCache.get(canonicalPath);
    if (cached) {
      return cached;
    }

    const promise = loadManifest(canonicalPath);
    loadCache.set(canonicalPath, promise);
    return promise;
  };

  const { visitAgent, visitTeam } = createCompilePlanTraversal({
    getLoadedManifest,
    nodeCache,
    edges,
    fingerprintCache,
    memberships
  });

  const rootLoadedManifest = await getLoadedManifest(rootManifestPath);
  if (isAgentManifest(rootLoadedManifest.manifest)) {
    await visitAgent(rootManifestPath, { isSubagent: false });
  } else {
    await visitTeam(rootManifestPath);
  }

  const nodes = assignStableNodeIds(
    [...nodeCache.values()]
      .sort((left, right) => left.source.localeCompare(right.source))
      .map((node) => ({
        id: "",
        kind: node.value.kind,
        runtimeName: node.runtimeName,
        slug: "",
        source: node.source,
        value: node.value
      }))
  );

  const idBySource = new Map(nodes.map((node) => [node.value.source, node.id]));

  const compilePlanNodes: CompilePlanNode[] = nodes;
  const compilePlanEdges = edges.map((edge) => ({
    ...edge,
    from: idBySource.get(edge.from) ?? edge.from,
    to: idBySource.get(edge.to) ?? edge.to
  }));

  const compilePlan: CompilePlan = {
    edges: compilePlanEdges,
    memberships: [...memberships.values()].sort((left, right) =>
      `${left.agentSource}:${left.teamSource}:${left.memberId}`.localeCompare(
        `${right.agentSource}:${right.teamSource}:${right.memberId}`
      )
    ),
    nodes: compilePlanNodes,
    root: rootManifestPath,
    runtimes: createRuntimeGroups(compilePlanNodes)
  };

  const organizationIdentity = resolveOrganizationIdentity(compilePlan);
  if (organizationIdentity) compilePlan.organizationIdentity = organizationIdentity;
  // Reject duplicate or invalid authored actor selections before attachment
  // synthesis can merge them into a single canonical attachment.
  validateB31MoltnetAuth(compilePlan);
  const externalParticipantIntents = resolveMoltnetExternalParticipantIntents(compilePlan);
  if (organizationIdentity) compilePlan.moltnetExternalParticipantIntents = externalParticipantIntents;
  compilePlan.moltnetRoomMemberships = resolveMoltnetRoomMemberships(compilePlan);
  resolvePlanMemoryAccess(compilePlan);
  resolvePlanMoltnetAttachments(compilePlan);
  // Recheck the actual canonical attachments emitted after representative
  // synthesis and duplicate merging.
  validateB31MoltnetAuth(compilePlan);
  validateAllowedWakeSenders(compilePlan);

  return compilePlan;
};
