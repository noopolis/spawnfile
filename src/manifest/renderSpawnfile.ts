import YAML from "yaml";

import type {
  AgentManifest,
  DocsBlock,
  DiscordSurfaceAccess,
  DiscordSurface,
  ExecutionBlock,
  ModelEntryAuth,
  ModelTarget,
  RuntimeBinding,
  SharedSurface,
  SurfacesBlock,
  TelegramSurface,
  TelegramSurfaceAccess,
  TeamManifest
} from "./schemas.js";

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

const orderDocs = (docs: DocsBlock | undefined): DocsBlock | undefined => {
  if (!docs) {
    return undefined;
  }

  return withDefinedEntries([
    ["identity", docs.identity],
    ["soul", docs.soul],
    ["system", docs.system],
    ["memory", docs.memory],
    ["heartbeat", docs.heartbeat],
    ["extras", docs.extras]
  ]) as unknown as DocsBlock;
};

const orderDiscordSurface = (
  surface: DiscordSurface | undefined
): DiscordSurface | undefined => {
  if (!surface) {
    return undefined;
  }

  return withDefinedEntries([
    ["access", orderDiscordSurfaceAccess(surface.access)],
    ["bot_token_secret", surface.bot_token_secret]
  ]) as unknown as DiscordSurface;
};

const orderDiscordSurfaceAccess = (
  access: DiscordSurfaceAccess | undefined
): DiscordSurfaceAccess | undefined => {
  if (!access) {
    return undefined;
  }

  return withDefinedEntries([
    ["mode", access.mode],
    ["users", access.users],
    ["guilds", access.guilds],
    ["channels", access.channels]
  ]) as unknown as DiscordSurfaceAccess;
};

const orderTelegramSurface = (
  surface: TelegramSurface | undefined
): TelegramSurface | undefined => {
  if (!surface) {
    return undefined;
  }

  return withDefinedEntries([
    ["access", orderTelegramSurfaceAccess(surface.access)],
    ["bot_token_secret", surface.bot_token_secret]
  ]) as unknown as TelegramSurface;
};

const orderTelegramSurfaceAccess = (
  access: TelegramSurfaceAccess | undefined
): TelegramSurfaceAccess | undefined => {
  if (!access) {
    return undefined;
  }

  return withDefinedEntries([
    ["mode", access.mode],
    ["users", access.users],
    ["chats", access.chats]
  ]) as unknown as TelegramSurfaceAccess;
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
    ["workspace", execution.workspace],
    ["sandbox", execution.sandbox]
  ]) as unknown as ExecutionBlock;
};

const orderSharedSurface = (
  shared: SharedSurface | undefined
): SharedSurface | undefined => {
  if (!shared) {
    return undefined;
  }

  return withDefinedEntries([
    ["env", shared.env],
    ["mcp_servers", shared.mcp_servers],
    ["secrets", shared.secrets],
    ["skills", shared.skills]
  ]) as unknown as SharedSurface;
};

const orderSurfaces = (
  surfaces: SurfacesBlock | undefined
): SurfacesBlock | undefined => {
  if (!surfaces) {
    return undefined;
  }

  return withDefinedEntries([
    ["discord", orderDiscordSurface(surfaces.discord)],
    ["telegram", orderTelegramSurface(surfaces.telegram)]
  ]) as unknown as SurfacesBlock;
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
    ["name", manifest.name]
  ]),
  withDefinedEntries([["runtime", orderRuntimeBinding(manifest.runtime)]]),
  withDefinedEntries([["execution", orderExecution(manifest.execution)]]),
  withDefinedEntries([["docs", orderDocs(manifest.docs)]]),
  withDefinedEntries([["surfaces", orderSurfaces(manifest.surfaces)]]),
  withDefinedEntries([
    ["skills", manifest.skills],
    ["mcp_servers", manifest.mcp_servers],
    ["secrets", manifest.secrets],
    ["env", manifest.env],
    ["policy", manifest.policy]
  ]),
  withDefinedEntries([["subagents", manifest.subagents]])
];

const orderTeamManifestSections = (manifest: TeamManifest): Record<string, unknown>[] => [
  withDefinedEntries([
    ["spawnfile_version", manifest.spawnfile_version],
    ["kind", manifest.kind],
    ["name", manifest.name]
  ]),
  withDefinedEntries([["runtime", orderRuntimeBinding(manifest.runtime)]]),
  withDefinedEntries([["execution", orderExecution(manifest.execution)]]),
  withDefinedEntries([
    ["docs", orderDocs(manifest.docs)],
    ["shared", orderSharedSurface(manifest.shared)]
  ]),
  withDefinedEntries([
    ["skills", manifest.skills],
    ["mcp_servers", manifest.mcp_servers],
    ["secrets", manifest.secrets],
    ["env", manifest.env],
    ["policy", manifest.policy]
  ]),
  withDefinedEntries([
    ["members", manifest.members],
    ["structure", manifest.structure]
  ])
];

export const renderSpawnfile = (manifest: AgentManifest | TeamManifest): string =>
  renderSections(
    manifest.kind === "agent"
      ? orderAgentManifestSections(manifest)
      : orderTeamManifestSections(manifest)
  );
