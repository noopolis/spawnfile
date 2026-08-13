import type {
  DiscordSurface,
  DiscordSurfaceAccess,
  MoltnetAttachment,
  MoltnetDM,
  MoltnetRoomBehavior,
  SlackSurface,
  SlackSurfaceAccess,
  SurfacesBlock,
  TelegramSurface,
  TelegramSurfaceAccess,
  WebhookSurface,
  WhatsAppSurface,
  WhatsAppSurfaceAccess
} from "./schemas.js";

const withDefinedEntries = (entries: Array<[string, unknown]>): Record<string, unknown> =>
  Object.fromEntries(entries.filter((entry) => entry[1] !== undefined));

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

  return withDefinedEntries([["wake", behavior.wake]]) as MoltnetRoomBehavior;
};

const orderMoltnetDm = (dms: MoltnetDM | undefined): MoltnetDM | undefined => {
  if (!dms) {
    return undefined;
  }

  return withDefinedEntries([
    ["enabled", dms.enabled],
    ["wake", dms.wake],
    ["allowed_wake_senders", dms.allowed_wake_senders]
  ]) as MoltnetDM;
};

const orderMoltnetAttachment = (attachment: MoltnetAttachment): MoltnetAttachment =>
  withDefinedEntries([
    ["network", attachment.network],
    ["auth", attachment.auth],
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
): SurfacesBlock["moltnet"] | undefined => surface?.map(orderMoltnetAttachment);

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

const orderSlackSurface = (surface: SlackSurface | undefined): SlackSurface | undefined => {
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

export const orderSurfaces = (
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
