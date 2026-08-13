import {
  getCanonicalManifestPath,
  getManifestPath,
  resolveProjectPath
} from "../filesystem/index.js";
import {
  type AgentManifest,
  LoadedManifest,
  isAgentManifest,
  isReferencedMember,
  isTeamManifest,
  materializeInlineAgentManifest
} from "../manifest/index.js";
import { SpawnfileError } from "../shared/index.js";
import {
  getAgentFingerprint,
  getMcpNames,
  getTeamFingerprint,
  validateEffectiveSkillRequirements
} from "./compilePlanHelpers.js";
import { loadResolvedSkills } from "./surfaces.js";
import { mergeCompatibleAgentNode } from "./agentNodeMerge.js";
import {
  CompilePlanEdge,
  ResolvedAgentNode,
  ResolvedMemberRef,
  ResolvedTeamMembershipContext,
  ResolvedTeamNode
} from "./types.js";
import {
  normalizeDescription,
  type AgentVisitContext
} from "./buildCompilePlanRuntime.js";
import {
  resolveTeamExternalIds,
  resolveTeamNetworks,
  validateTeamNetworkRooms
} from "./buildCompilePlanTeams.js";
import { resolveDeclaredMemoryBanks } from "./memoryResolution.js";
import { mergeWorkspaceResources } from "./workspaceResources.js";
import {
  DEFAULT_POLICY_MODE,
  DEFAULT_POLICY_ON_DEGRADE,
  type InternalNode,
  mergeResolvedDocuments,
} from "./buildCompilePlanTraversalHelpers.js";
import { resolveAgentNode } from "./buildCompilePlanAgent.js";
import { createInlineAgentSource } from "./projectManifestGraph.js";

type BuildCompilePlanTraversalDeps = {
  getLoadedManifest: (manifestPath: string) => Promise<LoadedManifest>;
  nodeCache: Map<string, InternalNode>;
  fingerprintCache: Map<string, string>;
  edges: CompilePlanEdge[];
  memberships: Map<string, ResolvedTeamMembershipContext>;
};

export const createCompilePlanTraversal = ({
  getLoadedManifest,
  nodeCache,
  fingerprintCache,
  edges,
  memberships
}: BuildCompilePlanTraversalDeps) => {
  const visitStack: string[] = [];

  const recordAgentMembership = (
    teamSource: string,
    teamName: string,
    memberId: string,
    agent: ResolvedAgentNode
  ): ResolvedMemberRef => {
    memberships.set(`${teamSource}::${memberId}::${agent.source}`, {
      agentSource: agent.source,
      memberId,
      teamName,
      teamSource
    });

    return {
      id: memberId,
      kind: "agent",
      nodeSource: agent.source,
      runtimeName: agent.runtime.name
    };
  };

  const visitAgentManifest = async (
    manifest: AgentManifest,
    source: string,
    manifestPath: string,
    context: AgentVisitContext
  ): Promise<ResolvedAgentNode> => {
    if (visitStack.includes(source)) {
      throw new SpawnfileError(
        "compile_error",
        `Cycle detected while visiting ${source}`
      );
    }

    const candidate = await resolveAgentNode({ context, manifest, manifestPath, source });
    const cachedNode = nodeCache.get(source);
    if (cachedNode) {
      const cachedAgent = cachedNode.value as ResolvedAgentNode;
      mergeCompatibleAgentNode(cachedAgent, candidate);
      fingerprintCache.set(source, getAgentFingerprint(cachedAgent));
      return cachedAgent;
    }

    const fingerprint = getAgentFingerprint(candidate);
    const existingFingerprint = fingerprintCache.get(source);
    if (existingFingerprint && existingFingerprint !== fingerprint) {
      throw new SpawnfileError(
        "compile_error",
        `Agent ${source} resolves differently across compile contexts`
      );
    }

    fingerprintCache.set(source, fingerprint);
    nodeCache.set(source, {
      runtimeName: candidate.runtime.name,
      source,
      value: candidate
    });

    visitStack.push(source);
    for (const subagent of manifest.subagents ?? []) {
      const childManifestPath = getManifestPath(resolveProjectPath(manifestPath, subagent.ref));
      const resolvedSubagent = await visitAgent(childManifestPath, {
        inheritedExecution: candidate.execution,
        inheritedResources: candidate.workspaceResources,
        inheritedRuntime: candidate.runtime,
        isSubagent: true
      });

      candidate.subagents.push({
        id: subagent.id,
        nodeSource: resolvedSubagent.source
      });
      edges.push({
        from: source,
        kind: "subagent",
        label: subagent.id,
        to: resolvedSubagent.source
      });
    }
    visitStack.pop();

    return candidate;
  };

  const visitAgent = async (
    manifestPath: string,
    context: AgentVisitContext
  ): Promise<ResolvedAgentNode> => {
    const canonicalPath = getCanonicalManifestPath(manifestPath);
    const loadedManifest = await getLoadedManifest(canonicalPath);
    if (!isAgentManifest(loadedManifest.manifest)) {
      throw new SpawnfileError(
        "compile_error",
        `Expected agent manifest, got ${loadedManifest.manifest.kind} at ${canonicalPath}`
      );
    }

    return visitAgentManifest(
      loadedManifest.manifest,
      canonicalPath,
      canonicalPath,
      context
    );
  };

  const visitTeam = async (
    manifestPath: string,
    inheritedResources: ResolvedAgentNode["workspaceResources"] = []
  ): Promise<ResolvedTeamNode> => {
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

    const manifest = loadedManifest.manifest;
    const sharedWorkspace = manifest.shared?.workspace;
    const sharedEnvironment = manifest.shared?.environment;
    const sharedSkills = await loadResolvedSkills(
      canonicalPath,
      sharedWorkspace?.skills
    );
    validateEffectiveSkillRequirements(
      loadedManifest.manifest.name,
      getMcpNames(sharedEnvironment?.mcp_servers ?? []),
      sharedSkills
    );

    const resolvedExternal = resolveTeamExternalIds(manifest);
    const docs = await mergeResolvedDocuments(canonicalPath, sharedWorkspace?.docs, undefined, undefined);
    const workspaceResources = mergeWorkspaceResources(
      inheritedResources,
      sharedWorkspace?.resources,
      manifest.name,
      {
        kind: "team",
        key: canonicalPath,
        name: manifest.name
      }
    );
    const candidate: ResolvedTeamNode = {
      description: manifest.description ? normalizeDescription(manifest.description) : "",
      docs,
      external: resolvedExternal,
      externalExplicit: manifest.external !== undefined,
      ...(manifest.external_participants
        ? { externalParticipants: manifest.external_participants }
        : {}),
      kind: "team",
      lead: manifest.lead ?? null,
      members: [],
      mode: manifest.mode,
      name: manifest.name,
      memory: resolveDeclaredMemoryBanks(manifest.memory, canonicalPath, "team", manifest.name),
      networks: resolveTeamNetworks(manifest),
      policyMode: manifest.policy?.mode ?? DEFAULT_POLICY_MODE,
      policyOnDegrade: manifest.policy?.on_degrade ?? DEFAULT_POLICY_ON_DEGRADE,
      workspaceResources,
      shared: {
        env: sharedEnvironment?.env ?? {},
        mcpServers: sharedEnvironment?.mcp_servers ?? [],
        packages: sharedEnvironment?.packages,
        secrets: sharedEnvironment?.secrets ?? [],
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
      if (!isReferencedMember(member)) {
        const resolvedAgent = await visitAgentManifest(
          materializeInlineAgentManifest(manifest, member),
          createInlineAgentSource(canonicalPath, member.id),
          canonicalPath,
          {
            inheritedShared: {
              manifestPath: canonicalPath,
              surface: manifest.shared
            },
            inheritedResources: candidate.workspaceResources,
            isSubagent: false
          }
        );
        const resolvedMember = recordAgentMembership(
          canonicalPath,
          candidate.name,
          member.id,
          resolvedAgent
        );
        candidate.members.push(resolvedMember);
        edges.push({
          from: canonicalPath,
          kind: "team_member",
          label: member.id,
          to: resolvedMember.nodeSource
        });
        continue;
      }
      const childManifestPath = getManifestPath(resolveProjectPath(canonicalPath, member.ref));
      const childManifest = await getLoadedManifest(childManifestPath);

      let resolvedMember: ResolvedMemberRef;
      if (isAgentManifest(childManifest.manifest)) {
        const resolvedAgent = await visitAgent(childManifestPath, {
          inheritedShared: {
            manifestPath: canonicalPath,
            surface: loadedManifest.manifest.shared
          },
          inheritedResources: candidate.workspaceResources,
          isSubagent: false
        });

        resolvedMember = recordAgentMembership(
          canonicalPath,
          candidate.name,
          member.id,
          resolvedAgent
        );
      } else {
        const resolvedTeam = await visitTeam(childManifestPath, candidate.workspaceResources);
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

  return {
    visitAgent,
    visitTeam
  };
};

export type { InternalNode };
