import { resolveEffectiveModelTarget } from "../modelEnv.js";
import { listInteractiveSurfaceScopes } from "../interactiveSurfaceScopes.js";
import type { CompilePlan, CompilePlanNode, ResolvedAgentSurfaces } from "../types.js";
import type {
  OrganizationRuntimeView,
  OrganizationViewDeclaredSummary,
  OrganizationViewModelSummary,
  OrganizationViewPackageSummary,
  OrganizationViewResourceSummary,
  OrganizationViewScheduleSummary,
  OrganizationViewSurfaceSummary
} from "./types.js";

const summarizeModel = (
  node: CompilePlanNode
): OrganizationViewModelSummary | null => {
  if (node.value.kind !== "agent" || !node.value.execution?.model?.primary) {
    return null;
  }

  const target = resolveEffectiveModelTarget(
    node.value.execution.model.primary,
    node.value.execution
  );
  return {
    authMethod: target.auth.method,
    name: target.name,
    provider: target.provider
  };
};

const summarizeSchedule = (
  node: CompilePlanNode
): OrganizationViewScheduleSummary | null => {
  if (node.value.kind !== "agent" || !node.value.schedule) {
    return null;
  }

  const schedule = node.value.schedule;
  if (schedule.kind === "cron") {
    return {
      expression: schedule.cron,
      kind: schedule.kind,
      ...(schedule.timezone ? { timezone: schedule.timezone } : {})
    };
  }

  if (schedule.kind === "every") {
    return {
      expression: schedule.every,
      kind: schedule.kind,
      ...(schedule.timezone ? { timezone: schedule.timezone } : {})
    };
  }

  return { kind: schedule.kind };
};

const surfaceSummaryFor = (
  name: keyof ResolvedAgentSurfaces,
  surfaces: ResolvedAgentSurfaces
): OrganizationViewSurfaceSummary | null => {
  if (!surfaces[name]) {
    return null;
  }

  const scopes = name === "moltnet"
    ? listInteractiveSurfaceScopes(surfaces).filter((scope) => scope.startsWith("moltnet:"))
    : listInteractiveSurfaceScopes(surfaces).filter((scope) => scope === name);
  return {
    name,
    scopes: scopes.length > 0 ? scopes : [name]
  };
};

const summarizeSurfaces = (node: CompilePlanNode): OrganizationViewSurfaceSummary[] => {
  const surfaces = node.value.kind === "agent" ? node.value.surfaces : undefined;
  if (!surfaces) {
    return [];
  }

  return (["discord", "http", "moltnet", "slack", "telegram", "webhook", "whatsapp"] as const)
    .map((name) => surfaceSummaryFor(name, surfaces))
    .filter((surface): surface is OrganizationViewSurfaceSummary => surface !== null);
};

const summarizePackages = (node: CompilePlanNode): OrganizationViewPackageSummary[] => {
  const packages = node.value.kind === "agent"
    ? node.value.packages ?? []
    : node.value.shared.packages ?? [];
  return packages.map((pkg) => ({
    id: pkg.id,
    manager: pkg.manager,
    name: pkg.name,
    ...(pkg.scope ? { scope: pkg.scope } : {}),
    ...(pkg.version ? { version: pkg.version } : {})
  }));
};

const summarizeResources = (node: CompilePlanNode): OrganizationViewResourceSummary[] =>
  (node.value.workspaceResources ?? []).map((resource) => ({
    id: resource.id,
    kind: resource.kind,
    mode: resource.mode,
    mount: resource.mount,
    sharing: resource.sharing
  }));

export const buildDeclaredNodeView = (
  node: CompilePlanNode
): OrganizationViewDeclaredSummary => {
  const skills = node.value.kind === "agent" ? node.value.skills : node.value.shared.skills;
  const mcpServers = node.value.kind === "agent"
    ? node.value.mcpServers
    : node.value.shared.mcpServers;

  return {
    docs: node.value.docs.map((doc) => ({ role: doc.role, source: doc.sourcePath })),
    mcpServers: mcpServers.map((server) => ({
      name: server.name,
      transport: server.transport
    })),
    model: summarizeModel(node),
    packages: summarizePackages(node),
    policy: {
      mode: node.value.policyMode,
      onDegrade: node.value.policyOnDegrade
    },
    resources: summarizeResources(node),
    schedule: summarizeSchedule(node),
    skills: skills.map((skill) => ({
      name: skill.name,
      ref: skill.ref,
      requiresMcp: [...skill.requiresMcp]
    })),
    surfaces: summarizeSurfaces(node)
  };
};

export const buildRuntimeViews = (plan: CompilePlan): OrganizationRuntimeView[] =>
  Object.entries(plan.runtimes)
    .map(([name, runtime]) => ({ name, nodeIds: [...runtime.nodeIds].sort() }))
    .sort((left, right) => left.name.localeCompare(right.name));
