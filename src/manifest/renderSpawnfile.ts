import YAML from "yaml";

import type {
  AgentManifest,
  AgentSchedule,
  DiscordSurfaceAccess,
  DiscordSurface,
  ExecutionBlock,
  MoltnetAttachment,
  MoltnetDM,
  MoltnetRoomBehavior,
  ModelEntryAuth,
  ModelTarget,
  RuntimeBinding,
  SlackSurface,
  SlackSurfaceAccess,
  SharedSurface,
  SurfacesBlock,
  TelegramSurface,
  TelegramSurfaceAccess,
  TeamManifest,
  WebhookSurface,
  WhatsAppSurface,
  WhatsAppSurfaceAccess
} from "./schemas.js";
import { orderTeamNetworks } from "./renderSpawnfileNetworks.js";
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

const orderDiscordSurface = (
  surface: DiscordSurface | undefined
): DiscordSurface | undefined => {
  if (!surface) {
    return undefined;
  }

  return withDefinedEntries([
    ["access", orderDiscordSurfaceAccess(surface.access)],
    ["bot_token_secret", surface.bot_token_secret],
    ["identity", surface.identity]
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
    ["bot_token_secret", surface.bot_token_secret],
    ["identity", surface.identity]
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

const orderWebhookSurface = (
  surface: WebhookSurface | undefined
): WebhookSurface | undefined => {
  if (!surface) {
    return undefined;
  }

  return withDefinedEntries([
    ["url", surface.url],
    ["signing_secret", surface.signing_secret]
  ]) as unknown as WebhookSurface;
};

const orderMoltnetRoomBehavior = (
  behavior: MoltnetRoomBehavior | undefined
): MoltnetRoomBehavior | undefined => {
  if (!behavior) {
    return undefined;
  }

  return withDefinedEntries([
    ["read", behavior.read],
    ["reply", behavior.reply]
  ]) as MoltnetRoomBehavior;
};

const orderMoltnetDm = (dms: MoltnetDM | undefined): MoltnetDM | undefined => {
  if (!dms) {
    return undefined;
  }

  return withDefinedEntries([
    ["enabled", dms.enabled],
    ["read", dms.read],
    ["reply", dms.reply]
  ]) as MoltnetDM;
};

const orderMoltnetAttachment = (
  attachment: MoltnetAttachment
): MoltnetAttachment =>
  withDefinedEntries([
    ["network", attachment.network],
    [
      "rooms",
      attachment.rooms
        ? Object.fromEntries(
            Object.entries(attachment.rooms)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([roomId, behavior]) => [roomId, orderMoltnetRoomBehavior(behavior)])
          )
        : undefined
    ],
    ["dms", orderMoltnetDm(attachment.dms)]
  ]) as MoltnetAttachment;

const orderMoltnetSurface = (
  surface: SurfacesBlock["moltnet"]
): SurfacesBlock["moltnet"] | undefined =>
  surface?.map(orderMoltnetAttachment);

const orderWhatsAppSurface = (
  surface: WhatsAppSurface | undefined
): WhatsAppSurface | undefined => {
  if (!surface) {
    return undefined;
  }

  return withDefinedEntries([
    ["access", orderWhatsAppSurfaceAccess(surface.access)],
    ["identity", surface.identity]
  ]) as unknown as WhatsAppSurface;
};

const orderWhatsAppSurfaceAccess = (
  access: WhatsAppSurfaceAccess | undefined
): WhatsAppSurfaceAccess | undefined => {
  if (!access) {
    return undefined;
  }

  return withDefinedEntries([
    ["mode", access.mode],
    ["users", access.users],
    ["groups", access.groups]
  ]) as unknown as WhatsAppSurfaceAccess;
};

const orderSlackSurface = (
  surface: SlackSurface | undefined
): SlackSurface | undefined => {
  if (!surface) {
    return undefined;
  }

  return withDefinedEntries([
    ["access", orderSlackSurfaceAccess(surface.access)],
    ["bot_token_secret", surface.bot_token_secret],
    ["app_token_secret", surface.app_token_secret],
    ["identity", surface.identity]
  ]) as unknown as SlackSurface;
};

const orderSlackSurfaceAccess = (
  access: SlackSurfaceAccess | undefined
): SlackSurfaceAccess | undefined => {
  if (!access) {
    return undefined;
  }

  return withDefinedEntries([
    ["mode", access.mode],
    ["users", access.users],
    ["channels", access.channels]
  ]) as unknown as SlackSurfaceAccess;
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
    ["telegram", orderTelegramSurface(surfaces.telegram)],
    ["whatsapp", orderWhatsAppSurface(surfaces.whatsapp)],
    ["slack", orderSlackSurface(surfaces.slack)],
    ["webhook", orderWebhookSurface(surfaces.webhook)],
    ["moltnet", orderMoltnetSurface(surfaces.moltnet)]
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
    ["name", manifest.name],
    ["expose", manifest.expose]
  ]),
  withDefinedEntries([["runtime", orderRuntimeBinding(manifest.runtime)]]),
  withDefinedEntries([["execution", orderExecution(manifest.execution)]]),
  withDefinedEntries([["schedule", orderAgentSchedule(manifest.schedule)]]),
  withDefinedEntries([["workspace", orderWorkspace(manifest.workspace)]]),
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
    ["workspace", orderWorkspace(manifest.workspace)],
    ["shared", orderSharedSurface(manifest.shared)],
    ["networks", orderTeamNetworks(manifest.networks)]
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
    ["mode", manifest.mode],
    ["lead", manifest.lead],
    ["external", manifest.external]
  ])
];

export const renderSpawnfile = (manifest: AgentManifest | TeamManifest): string =>
  renderSections(
    manifest.kind === "agent"
      ? orderAgentManifestSections(manifest)
      : orderTeamManifestSections(manifest)
  );
