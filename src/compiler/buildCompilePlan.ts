import {
  getCanonicalManifestPath,
  getManifestPath,
  resolveProjectPath
} from "../filesystem/index.js";
import {
  AgentManifest,
  ExecutionBlock,
  LoadedManifest,
  SharedSurface,
  TeamManifest,
  isAgentManifest,
  isTeamManifest,
  loadManifest,
  mergeExecution,
  normalizeRuntimeBinding
} from "../manifest/index.js";
import { assertRuntimeCanCompile } from "../runtime/index.js";
import { SpawnfileError } from "../shared/index.js";

import { assignStableNodeIds, stableStringify } from "./helpers.js";
import {
  loadResolvedDocuments,
  mergeResolvedSkills,
  loadResolvedSkills,
  mergeSharedSurface
} from "./surfaces.js";
import { assertRuntimeSupportsExecutionModelAuth } from "./modelAuth.js";
import {
  CompilePlan,
  CompilePlanEdge,
  CompilePlanNode,
  ResolvedAgentNode,
  ResolvedMemberRef,
  ResolvedRuntime,
  ResolvedTeamNode
} from "./types.js";
import { applyExecutionDefaults } from "./executionDefaults.js";

interface AgentVisitContext {
  inheritedExecution?: ExecutionBlock;
  inheritedShared?: {
    manifestPath: string;
    surface: SharedSurface | undefined;
  };
  inheritedRuntime?: ResolvedRuntime;
  isSubagent: boolean;
}

type InternalNode = {
  runtimeName: string | null;
  source: string;
  value: ResolvedAgentNode | ResolvedTeamNode;
};

const getMcpNames = (servers: Array<{ name: string }>): Set<string> =>
  new Set(servers.map((server) => server.name));

const validateEffectiveSkillRequirements = (
  nodeName: string,
  mcpNames: Set<string>,
  skills: Array<{ name: string; requiresMcp: string[] }>
): void => {
  for (const skill of skills) {
    for (const mcpName of skill.requiresMcp) {
      if (!mcpNames.has(mcpName)) {
        throw new SpawnfileError(
          "validation_error",
          `Skill ${skill.name} on ${nodeName} requires undeclared MCP server: ${mcpName}`
        );
      }
    }
  }
};

const getAgentFingerprint = (node: ResolvedAgentNode): string =>
  stableStringify({
    env: node.env,
    execution: node.execution,
    mcpServers: node.mcpServers,
    runtime: node.runtime,
    secrets: node.secrets,
    skills: node.skills.map((skill) => ({
      name: skill.name,
      ref: skill.ref,
      requiresMcp: skill.requiresMcp
    }))
  });

const getTeamFingerprint = (node: ResolvedTeamNode): string =>
  stableStringify({
    members: node.members,
    structure: node.structure,
    shared: {
      env: node.shared.env,
      mcpServers: node.shared.mcpServers,
      secrets: node.shared.secrets,
      skills: node.shared.skills.map((skill) => ({
        name: skill.name,
        ref: skill.ref,
        requiresMcp: skill.requiresMcp
      }))
    }
  });

const resolveRuntime = async (
  manifest: AgentManifest,
  context: AgentVisitContext
): Promise<ResolvedRuntime> => {
  const localRuntime = normalizeRuntimeBinding(manifest.runtime);

  if (context.isSubagent) {
    if (!context.inheritedRuntime) {
      throw new SpawnfileError(
        "runtime_error",
        `Subagent ${manifest.name} is missing inherited runtime context`
      );
    }

    if (
      localRuntime &&
      localRuntime.name !== context.inheritedRuntime.name
    ) {
      throw new SpawnfileError(
        "runtime_error",
        `Subagent ${manifest.name} must match parent runtime`
      );
    }

    return context.inheritedRuntime;
  }

  if (!localRuntime) {
    throw new SpawnfileError(
      "runtime_error",
      `Agent ${manifest.name} does not declare a runtime`
    );
  }

  await assertRuntimeCanCompile(localRuntime.name);

  return localRuntime;
};

export const buildCompilePlan = async (inputPath: string): Promise<CompilePlan> => {
  const rootManifestPath = getCanonicalManifestPath(getManifestPath(inputPath));
  const loadCache = new Map<string, Promise<LoadedManifest>>();
  const nodeCache = new Map<string, InternalNode>();
  const fingerprintCache = new Map<string, string>();
  const edges: CompilePlanEdge[] = [];
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

    const candidate: ResolvedAgentNode = {
      docs: await loadResolvedDocuments(canonicalPath, loadedManifest.manifest.docs),
      env: sharedSurface.env,
      execution,
      kind: "agent",
      mcpServers: sharedSurface.mcpServers,
      name: loadedManifest.manifest.name,
      policyMode: loadedManifest.manifest.policy?.mode ?? null,
      policyOnDegrade: loadedManifest.manifest.policy?.on_degrade ?? null,
      runtime,
      secrets: sharedSurface.secrets,
      skills,
      source: canonicalPath,
      subagents: []
    };

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

    const structure = loadedManifest.manifest.structure;
    const memberIds = loadedManifest.manifest.members.map((member) => member.id);
    const resolvedExternal = structure.external
      ?? (structure.mode === "hierarchical" && structure.leader
        ? [structure.leader]
        : memberIds);

    const candidate: ResolvedTeamNode = {
      docs: await loadResolvedDocuments(canonicalPath, loadedManifest.manifest.docs),
      kind: "team",
      members: [],
      name: loadedManifest.manifest.name,
      policyMode: loadedManifest.manifest.policy?.mode ?? null,
      policyOnDegrade: loadedManifest.manifest.policy?.on_degrade ?? null,
      shared: {
        env: loadedManifest.manifest.shared?.env ?? {},
        mcpServers: loadedManifest.manifest.shared?.mcp_servers ?? [],
        secrets: loadedManifest.manifest.shared?.secrets ?? [],
        skills: sharedSkills
      },
      source: canonicalPath,
      structure: {
        external: resolvedExternal,
        leader: structure.leader ?? null,
        mode: structure.mode
      }
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

  return {
    edges: compilePlanEdges,
    nodes: compilePlanNodes,
    root: rootManifestPath,
    runtimes
  };
};
