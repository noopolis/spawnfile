import YAML from "yaml";

import type {
  AgentManifest,
  AgentSchedule,
  ExecutionBlock,
  ModelEntryAuth,
  ModelTarget,
  Environment,
  ManifestMember,
  RuntimeBinding,
  SharedSurface,
  TeamManifest,
} from "./schemas.js";
import { isReferencedMember } from "./schemas.js";
import { orderTeamNetworks } from "./renderSpawnfileNetworks.js";
import { orderSurfaces } from "./renderSpawnfileSurfaces.js";
import { orderWorkspace } from "./renderSpawnfileWorkspace.js";

const withDefinedEntries = (entries: Array<[string, unknown]>): Record<string, unknown> =>
  Object.fromEntries(entries.filter((entry) => entry[1] !== undefined));

const hasEntries = (value: Record<string, unknown>): boolean => Object.keys(value).length > 0;

const orderRuntimeBinding = (
  runtime: RuntimeBinding | undefined
): RuntimeBinding | undefined => {
  if (!runtime || typeof runtime === "string") {
    return runtime;
  }

  return withDefinedEntries([
    ["name", runtime.name],
    ["options", runtime.options]
  ]) as unknown as RuntimeBinding;
};

const orderModelEntryAuth = (
  auth: ModelEntryAuth | undefined
): ModelEntryAuth | undefined => {
  if (!auth) {
    return undefined;
  }

  return withDefinedEntries([
    ["method", auth.method],
    ["key", auth.key]
  ]) as unknown as ModelEntryAuth;
};

const orderModelTarget = (target: ModelTarget | undefined): ModelTarget | undefined => {
  if (!target) {
    return undefined;
  }

  return withDefinedEntries([
    ["provider", target.provider],
    ["name", target.name],
    ["auth", orderModelEntryAuth(target.auth)],
    ["endpoint", target.endpoint]
  ]) as unknown as ModelTarget;
};

const orderExecution = (
  execution: ExecutionBlock | undefined
): ExecutionBlock | undefined => {
  if (!execution) {
    return undefined;
  }

  return withDefinedEntries([
    [
      "model",
      execution.model
        ? withDefinedEntries([
            ["primary", orderModelTarget(execution.model.primary)],
            ["fallback", execution.model.fallback?.map(orderModelTarget)],
            ["auth", execution.model.auth]
          ])
        : undefined
    ],
    ["sandbox", execution.sandbox]
  ]) as unknown as ExecutionBlock;
};

const orderAgentSchedule = (
  schedule: AgentSchedule | undefined
): AgentSchedule | undefined => {
  if (!schedule) {
    return undefined;
  }

  if (schedule.kind === "cron") {
    return withDefinedEntries([
      ["kind", schedule.kind],
      ["cron", schedule.cron],
      ["timezone", schedule.timezone],
      ["prompt", schedule.prompt]
    ]) as AgentSchedule;
  }

  if (schedule.kind === "every") {
    return withDefinedEntries([
      ["kind", schedule.kind],
      ["every", schedule.every],
      ["timezone", schedule.timezone],
      ["prompt", schedule.prompt]
    ]) as AgentSchedule;
  }

  return { kind: schedule.kind };
};

const orderEnvironment = (environment: Environment | undefined): Environment | undefined => {
  if (!environment) {
    return undefined;
  }

  return withDefinedEntries([
    ["env", environment.env],
    ["secrets", environment.secrets],
    ["packages", environment.packages],
    ["mcp_servers", environment.mcp_servers]
  ]) as unknown as Environment;
};

const orderSharedSurface = (
  shared: SharedSurface | undefined
): SharedSurface | undefined => {
  if (!shared) {
    return undefined;
  }

  return withDefinedEntries([
    ["workspace", orderWorkspace(shared.workspace)],
    ["environment", orderEnvironment(shared.environment)]
  ]) as unknown as SharedSurface;
};

const orderMember = (member: ManifestMember): Record<string, unknown> => {
  if (isReferencedMember(member)) {
    return withDefinedEntries([
      ["id", member.id],
      ["ref", member.ref]
    ]);
  }

  return withDefinedEntries([
    ["id", member.id],
    ["description", member.description],
    ["expose", member.expose],
    ["runtime", orderRuntimeBinding(member.runtime)],
    ["execution", orderExecution(member.execution)],
    ["schedule", orderAgentSchedule(member.schedule)],
    ["workspace", orderWorkspace(member.workspace)],
    ["environment", orderEnvironment(member.environment)],
    ["surfaces", orderSurfaces(member.surfaces)],
    ["memory", member.memory],
    ["policy", member.policy]
  ]);
};

const renderSections = (sections: Record<string, unknown>[]): string =>
  sections
    .filter(hasEntries)
    .map((section) => YAML.stringify(section))
    .join("\n");

const orderAgentManifestSections = (manifest: AgentManifest): Record<string, unknown>[] => [
  withDefinedEntries([
    ["spawnfile_version", manifest.spawnfile_version],
    ["kind", manifest.kind],
    ["name", manifest.name],
    ["expose", manifest.expose]
  ]),
  withDefinedEntries([["runtime", orderRuntimeBinding(manifest.runtime)]]),
  withDefinedEntries([["execution", orderExecution(manifest.execution)]]),
  withDefinedEntries([["schedule", orderAgentSchedule(manifest.schedule)]]),
  withDefinedEntries([["workspace", orderWorkspace(manifest.workspace)]]),
  withDefinedEntries([["environment", orderEnvironment(manifest.environment)]]),
  withDefinedEntries([["surfaces", orderSurfaces(manifest.surfaces)]]),
  withDefinedEntries([["policy", manifest.policy]]),
  withDefinedEntries([["subagents", manifest.subagents]])
];

const orderTeamManifestSections = (manifest: TeamManifest): Record<string, unknown>[] => [
  withDefinedEntries([
    ["spawnfile_version", manifest.spawnfile_version],
    ["kind", manifest.kind],
    ["name", manifest.name]
  ]),
  withDefinedEntries([["execution", orderExecution(manifest.execution)]]),
  withDefinedEntries([["shared", orderSharedSurface(manifest.shared)]]),
  withDefinedEntries([["networks", orderTeamNetworks(manifest.networks)]]),
  withDefinedEntries([["policy", manifest.policy]]),
  withDefinedEntries([
    ["members", manifest.members.map(orderMember)],
    ["mode", manifest.mode],
    ["lead", manifest.lead],
    ["external", manifest.external]
  ]),
  withDefinedEntries([["external_participants", manifest.external_participants]])
];

export const renderSpawnfile = (manifest: AgentManifest | TeamManifest): string =>
  renderSections(
    manifest.kind === "agent"
      ? orderAgentManifestSections(manifest)
      : orderTeamManifestSections(manifest)
  );
