import {
  getCanonicalManifestPath,
  getManifestPath,
  resolveProjectPath
} from "../filesystem/index.js";
import {
  LoadedManifest,
  isAgentManifest,
  isTeamManifest,
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
import {
  mergeResolvedSkills,
  loadResolvedSkills
} from "./surfaces.js";
import { assertRuntimeSupportsExecutionModelAuth } from "./modelAuth.js";
import { assertRuntimeSupportsAgentSurfaces } from "./surfaceSupport.js";
import {
  CompilePlanEdge,
  ResolvedAgentNode,
  ResolvedMemberRef,
  ResolvedTeamMembershipContext,
  ResolvedTeamNode
} from "./types.js";
import { applyExecutionDefaults } from "./executionDefaults.js";
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
import { mergeWorkspaceResources } from "./workspaceResources.js";
import {
  DEFAULT_POLICY_MODE,
  DEFAULT_POLICY_ON_DEGRADE,
  type InternalNode,
  mergeResolvedDocuments,
  resolveEffectiveEnvironment
} from "./buildCompilePlanTraversalHelpers.js";

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

    const environment = resolveEffectiveEnvironment(
      context.inheritedShared?.surface?.environment,
      loadedManifest.manifest.environment
    );
    const inheritedSkills = context.inheritedShared
      ? await loadResolvedSkills(
          context.inheritedShared.manifestPath,
          context.inheritedShared.surface?.workspace?.skills
        )
      : [];
    const localSkills = await loadResolvedSkills(
      canonicalPath,
      loadedManifest.manifest.workspace?.skills
    );
    const skills = mergeResolvedSkills(inheritedSkills, localSkills);
    validateEffectiveSkillRequirements(
      loadedManifest.manifest.name,
      getMcpNames(environment.mcpServers),
      skills
    );

    const docs = await mergeResolvedDocuments(
      canonicalPath,
      loadedManifest.manifest.workspace?.docs,
      context.inheritedShared?.manifestPath,
      context.inheritedShared?.surface?.workspace?.docs
    );
    const workspaceResources = mergeWorkspaceResources(
      context.inheritedResources,
      loadedManifest.manifest.workspace?.resources,
      loadedManifest.manifest.name,
      {
        kind: "agent",
        key: canonicalPath,
        name: loadedManifest.manifest.name
      }
    );
    const candidate: ResolvedAgentNode = {
      description: resolveDescription(loadedManifest.manifest.description, docs),
      docs,
      env: environment.env,
      execution,
      expose: loadedManifest.manifest.expose ?? false,
      kind: "agent",
      mcpServers: environment.mcpServers,
      name: loadedManifest.manifest.name,
      policyMode: loadedManifest.manifest.policy?.mode ?? DEFAULT_POLICY_MODE,
      policyOnDegrade: loadedManifest.manifest.policy?.on_degrade ?? DEFAULT_POLICY_ON_DEGRADE,
      runtime,
      schedule: loadedManifest.manifest.schedule,
      secrets: environment.secrets,
      packages: environment.packages,
      skills,
      source: canonicalPath,
      surfaces: resolveAgentSurfaces(loadedManifest.manifest.surfaces),
      subagents: [],
      workspaceResources
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
        inheritedResources: candidate.workspaceResources,
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
      kind: "team",
      lead: manifest.lead ?? null,
      members: [],
      mode: manifest.mode,
      name: manifest.name,
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
