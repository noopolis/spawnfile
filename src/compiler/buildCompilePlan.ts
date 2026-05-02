import {
  getCanonicalManifestPath,
  getManifestPath,
  resolveProjectPath
} from "../filesystem/index.js";
import {
  LoadedManifest,
  isAgentManifest,
  isTeamManifest,
  loadManifest,
  mergeExecution
} from "../manifest/index.js";
import { SpawnfileError } from "../shared/index.js";
import {
  getAgentFingerprint,
  getMcpNames,
  getTeamFingerprint,
  validateEffectiveSkillRequirements
} from "./compilePlanHelpers.js";
import { resolveAgentSurfaces } from "./agentSurfaces.js";
import { assignStableNodeIds } from "./helpers.js";
import {
  loadResolvedDocuments,
  mergeResolvedSkills,
  loadResolvedSkills,
  mergeSharedSurface
} from "./surfaces.js";
import { assertRuntimeSupportsExecutionModelAuth } from "./modelAuth.js";
import { assertRuntimeSupportsAgentSurfaces } from "./surfaceSupport.js";
import {
  CompilePlan,
  CompilePlanEdge,
  CompilePlanNode,
  ResolvedAgentNode,
  ResolvedMemberRef,
  ResolvedTeamMembershipContext,
  ResolvedTeamNode
} from "./types.js";
import { applyExecutionDefaults } from "./executionDefaults.js";
import { resolvePlanMoltnetAttachments } from "./moltnetResolution.js";
import {
  normalizeDescription,
  resolveDescription,
  resolveRuntime,
  type AgentVisitContext
} from "./buildCompilePlanRuntime.js";
import {
  resolveTeamExternalIds,
  resolveTeamNetworks,
  validateTeamNetworkRooms
} from "./buildCompilePlanTeams.js";

type InternalNode = {
  runtimeName: string | null;
  source: string;
  value: ResolvedAgentNode | ResolvedTeamNode;
};

export const buildCompilePlan = async (inputPath: string): Promise<CompilePlan> => {
  const rootManifestPath = getCanonicalManifestPath(getManifestPath(inputPath));
  const loadCache = new Map<string, Promise<LoadedManifest>>();
  const nodeCache = new Map<string, InternalNode>();
  const fingerprintCache = new Map<string, string>();
  const edges: CompilePlanEdge[] = [];
  const memberships = new Map<string, ResolvedTeamMembershipContext>();
  const visitStack: string[] = [];

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

  const visitAgent = async (
    manifestPath: string,
    context: AgentVisitContext
  ): Promise<ResolvedAgentNode> => {
    const canonicalPath = getCanonicalManifestPath(manifestPath);
    if (visitStack.includes(canonicalPath)) {
      throw new SpawnfileError(
        "compile_error",
        `Cycle detected while visiting ${canonicalPath}`
      );
    }

    const loadedManifest = await getLoadedManifest(canonicalPath);
    if (!isAgentManifest(loadedManifest.manifest)) {
      throw new SpawnfileError(
        "compile_error",
        `Expected agent manifest, got ${loadedManifest.manifest.kind} at ${canonicalPath}`
      );
    }

    const runtime = await resolveRuntime(loadedManifest.manifest, context);
    const execution = applyExecutionDefaults(
      context.isSubagent
        ? mergeExecution(context.inheritedExecution, loadedManifest.manifest.execution)
        : loadedManifest.manifest.execution
    );
    assertRuntimeSupportsExecutionModelAuth(
      runtime.name,
      execution,
      loadedManifest.manifest.name
    );

    const sharedSurface = mergeSharedSurface(context.inheritedShared?.surface, {
      env: loadedManifest.manifest.env,
      mcpServers: loadedManifest.manifest.mcp_servers,
      secrets: loadedManifest.manifest.secrets,
      skills: loadedManifest.manifest.skills
    });

    const inheritedSkills = context.inheritedShared
      ? await loadResolvedSkills(
          context.inheritedShared.manifestPath,
          context.inheritedShared.surface?.skills
        )
      : [];
    const localSkills = await loadResolvedSkills(canonicalPath, loadedManifest.manifest.skills);
    const skills = mergeResolvedSkills(inheritedSkills, localSkills);
    validateEffectiveSkillRequirements(
      loadedManifest.manifest.name,
      getMcpNames(sharedSurface.mcpServers),
      skills
    );

    const docs = await loadResolvedDocuments(canonicalPath, loadedManifest.manifest.docs);
    const candidate: ResolvedAgentNode = {
      description: resolveDescription(loadedManifest.manifest.description, docs),
      docs,
      env: sharedSurface.env,
      execution,
      expose: loadedManifest.manifest.expose ?? false,
      kind: "agent",
      mcpServers: sharedSurface.mcpServers,
      name: loadedManifest.manifest.name,
      policyMode: loadedManifest.manifest.policy?.mode ?? null,
      policyOnDegrade: loadedManifest.manifest.policy?.on_degrade ?? null,
      runtime,
      secrets: sharedSurface.secrets,
      skills,
      source: canonicalPath,
      surfaces: resolveAgentSurfaces(loadedManifest.manifest.surfaces),
      subagents: []
    };
    assertRuntimeSupportsAgentSurfaces(
      runtime.name,
      candidate.surfaces,
      loadedManifest.manifest.name
    );

    const fingerprint = getAgentFingerprint(candidate);
    const existingFingerprint = fingerprintCache.get(canonicalPath);
    if (existingFingerprint && existingFingerprint !== fingerprint) {
      throw new SpawnfileError(
        "compile_error",
        `Manifest ${canonicalPath} resolves differently across compile contexts`
      );
    }

    const cachedNode = nodeCache.get(canonicalPath);
    if (cachedNode) {
      return cachedNode.value as ResolvedAgentNode;
    }

    fingerprintCache.set(canonicalPath, fingerprint);
    nodeCache.set(canonicalPath, {
      runtimeName: runtime.name,
      source: canonicalPath,
      value: candidate
    });

    visitStack.push(canonicalPath);
    for (const subagent of loadedManifest.manifest.subagents ?? []) {
      const childManifestPath = getManifestPath(resolveProjectPath(canonicalPath, subagent.ref));
      const resolvedSubagent = await visitAgent(childManifestPath, {
        inheritedExecution: execution,
        inheritedRuntime: runtime,
        isSubagent: true
      });

      candidate.subagents.push({
        id: subagent.id,
        nodeSource: resolvedSubagent.source
      });
      edges.push({
        from: canonicalPath,
        kind: "subagent",
        label: subagent.id,
        to: resolvedSubagent.source
      });
    }
    visitStack.pop();

    return candidate;
  };

  const visitTeam = async (manifestPath: string): Promise<ResolvedTeamNode> => {
    const canonicalPath = getCanonicalManifestPath(manifestPath);
    if (visitStack.includes(canonicalPath)) {
      throw new SpawnfileError(
        "compile_error",
        `Cycle detected while visiting ${canonicalPath}`
      );
    }

    const loadedManifest = await getLoadedManifest(canonicalPath);
    if (!isTeamManifest(loadedManifest.manifest)) {
      throw new SpawnfileError(
        "compile_error",
        `Expected team manifest, got ${loadedManifest.manifest.kind} at ${canonicalPath}`
      );
    }

    const sharedSkills = await loadResolvedSkills(canonicalPath, loadedManifest.manifest.shared?.skills);
    validateEffectiveSkillRequirements(
      loadedManifest.manifest.name,
      getMcpNames(loadedManifest.manifest.shared?.mcp_servers ?? []),
      sharedSkills
    );

    const manifest = loadedManifest.manifest;
    const resolvedExternal = resolveTeamExternalIds(manifest);
    const docs = await loadResolvedDocuments(canonicalPath, manifest.docs);
    const candidate: ResolvedTeamNode = {
      description: manifest.description ? normalizeDescription(manifest.description) : "",
      docs,
      external: resolvedExternal,
      externalExplicit: manifest.external !== undefined,
      kind: "team",
      lead: manifest.lead ?? null,
      members: [],
      mode: manifest.mode,
      name: manifest.name,
      networks: resolveTeamNetworks(manifest),
      policyMode: manifest.policy?.mode ?? null,
      policyOnDegrade: manifest.policy?.on_degrade ?? null,
      shared: {
        env: manifest.shared?.env ?? {},
        mcpServers: manifest.shared?.mcp_servers ?? [],
        secrets: manifest.shared?.secrets ?? [],
        skills: sharedSkills
      },
      source: canonicalPath,
    };

    const fingerprint = getTeamFingerprint(candidate);
    const existingFingerprint = fingerprintCache.get(canonicalPath);
    if (existingFingerprint && existingFingerprint !== fingerprint) {
      throw new SpawnfileError(
        "compile_error",
        `Team manifest ${canonicalPath} resolves differently across compile contexts`
      );
    }

    const cachedNode = nodeCache.get(canonicalPath);
    if (cachedNode) {
      return cachedNode.value as ResolvedTeamNode;
    }

    fingerprintCache.set(canonicalPath, fingerprint);
    nodeCache.set(canonicalPath, {
      runtimeName: null,
      source: canonicalPath,
      value: candidate
    });

    visitStack.push(canonicalPath);
    for (const member of loadedManifest.manifest.members) {
      const childManifestPath = getManifestPath(resolveProjectPath(canonicalPath, member.ref));
      const childManifest = await getLoadedManifest(childManifestPath);

      let resolvedMember: ResolvedMemberRef;
      if (isAgentManifest(childManifest.manifest)) {
        const resolvedAgent = await visitAgent(childManifestPath, {
          inheritedShared: {
            manifestPath: canonicalPath,
            surface: loadedManifest.manifest.shared
          },
          isSubagent: false
        });

        resolvedMember = {
          id: member.id,
          kind: "agent",
          nodeSource: resolvedAgent.source,
          runtimeName: resolvedAgent.runtime.name
        };
        memberships.set(
          `${canonicalPath}::${member.id}::${resolvedAgent.source}`,
          {
            agentSource: resolvedAgent.source,
            memberId: member.id,
            teamName: candidate.name,
            teamSource: canonicalPath
          }
        );
      } else {
        const resolvedTeam = await visitTeam(childManifestPath);
        resolvedMember = {
          id: member.id,
          kind: "team",
          nodeSource: resolvedTeam.source,
          runtimeName: null
        };
      }

      candidate.members.push(resolvedMember);
      edges.push({
        from: canonicalPath,
        kind: "team_member",
        label: member.id,
        to: resolvedMember.nodeSource
      });
    }

    validateTeamNetworkRooms(candidate);

    visitStack.pop();

    return candidate;
  };

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

  const runtimes = compilePlanNodes.reduce<Record<string, { nodeIds: string[] }>>((groups, node) => {
    if (!node.runtimeName) {
      return groups;
    }

    const group = groups[node.runtimeName] ?? { nodeIds: [] };
    group.nodeIds.push(node.id);
    groups[node.runtimeName] = group;
    return groups;
  }, {});

  const compilePlan: CompilePlan = {
    edges: compilePlanEdges,
    memberships: [...memberships.values()].sort((left, right) =>
      `${left.agentSource}:${left.teamSource}:${left.memberId}`.localeCompare(
        `${right.agentSource}:${right.teamSource}:${right.memberId}`
      )
    ),
    nodes: compilePlanNodes,
    root: rootManifestPath,
    runtimes
  };

  resolvePlanMoltnetAttachments(compilePlan);

  return compilePlan;
};
