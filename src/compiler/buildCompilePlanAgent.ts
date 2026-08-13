import { mergeExecution, type AgentManifest } from "../manifest/index.js";

import { resolveAgentSurfaces } from "./agentSurfaces.js";
import type { AgentVisitContext } from "./buildCompilePlanRuntime.js";
import { resolveDescription, resolveRuntime } from "./buildCompilePlanRuntime.js";
import {
  DEFAULT_POLICY_MODE,
  DEFAULT_POLICY_ON_DEGRADE,
  mergeResolvedDocuments,
  resolveEffectiveEnvironment
} from "./buildCompilePlanTraversalHelpers.js";
import {
  getMcpNames,
  validateEffectiveSkillRequirements
} from "./compilePlanHelpers.js";
import { applyExecutionDefaults } from "./executionDefaults.js";
import { resolveDeclaredMemoryBanks } from "./memoryResolution.js";
import { assertRuntimeSupportsExecutionModelAuth } from "./modelAuth.js";
import { loadResolvedSkills, mergeResolvedSkills } from "./surfaces.js";
import { assertRuntimeSupportsAgentSurfaces } from "./surfaceSupport.js";
import type { ResolvedAgentNode } from "./types.js";
import { mergeWorkspaceResources } from "./workspaceResources.js";

interface ResolveAgentNodeOptions {
  context: AgentVisitContext;
  manifest: AgentManifest;
  manifestPath: string;
  source: string;
}

export const resolveAgentNode = async ({
  context,
  manifest,
  manifestPath,
  source
}: ResolveAgentNodeOptions): Promise<ResolvedAgentNode> => {
  const runtime = await resolveRuntime(manifest, context);
  const execution = applyExecutionDefaults(
    context.isSubagent
      ? mergeExecution(context.inheritedExecution, manifest.execution)
      : manifest.execution
  );
  assertRuntimeSupportsExecutionModelAuth(runtime.name, execution, manifest.name);

  const environment = resolveEffectiveEnvironment(
    context.inheritedShared?.surface?.environment,
    manifest.environment
  );
  const inheritedSkills = context.inheritedShared
    ? await loadResolvedSkills(
        context.inheritedShared.manifestPath,
        context.inheritedShared.surface?.workspace?.skills
      )
    : [];
  const localSkills = await loadResolvedSkills(manifestPath, manifest.workspace?.skills);
  const skills = mergeResolvedSkills(inheritedSkills, localSkills);
  validateEffectiveSkillRequirements(
    manifest.name,
    getMcpNames(environment.mcpServers),
    skills
  );

  const docs = await mergeResolvedDocuments(
    manifestPath,
    manifest.workspace?.docs,
    context.inheritedShared?.manifestPath,
    context.inheritedShared?.surface?.workspace?.docs
  );
  const workspaceResources = mergeWorkspaceResources(
    context.inheritedResources,
    manifest.workspace?.resources,
    manifest.name,
    {
      kind: "agent",
      key: source,
      name: manifest.name
    }
  );
  const candidate: ResolvedAgentNode = {
    description: resolveDescription(manifest.description, docs),
    docs,
    env: environment.env,
    execution,
    expose: manifest.expose ?? false,
    kind: "agent",
    mcpServers: environment.mcpServers,
    name: manifest.name,
    policyMode: manifest.policy?.mode ?? DEFAULT_POLICY_MODE,
    policyOnDegrade: manifest.policy?.on_degrade ?? DEFAULT_POLICY_ON_DEGRADE,
    runtime,
    memory: resolveDeclaredMemoryBanks(manifest.memory, source, "agent", manifest.name),
    schedule: manifest.schedule,
    secrets: environment.secrets,
    packages: environment.packages,
    skills,
    source,
    ...(source === manifestPath ? {} : { sourcePath: manifestPath }),
    surfaces: resolveAgentSurfaces(manifest.surfaces),
    subagents: [],
    workspaceResources
  };
  assertRuntimeSupportsAgentSurfaces(runtime.name, candidate.surfaces, manifest.name);

  return candidate;
};
