import type { ResolvedAgentSurfaces } from "../../compiler/types.js";
import type { RuntimeContainerConfigEnvBinding } from "../types.js";
import { SpawnfileError } from "../../shared/index.js";

const buildOpenClawDiscordConfig = (
  surfaces: ResolvedAgentSurfaces
): Record<string, unknown> => {
  const discordSurface = surfaces.discord;
  if (!discordSurface) {
    return {};
  }

  const config: Record<string, unknown> = {
    enabled: true
  };
  const access = discordSurface.access;

  if (!access) {
    return config;
  }

  if (access.mode === "pairing") {
    return {
      ...config,
      dmPolicy: "pairing"
    };
  }

  if (access.mode === "open") {
    return {
      ...config,
      allowFrom: ["*"],
      dmPolicy: "open",
      groupPolicy: "open"
    };
  }

  if (access.channels.length > 0 && access.guilds.length !== 1) {
    throw new SpawnfileError(
      "validation_error",
      "OpenClaw Discord channel allowlists require exactly one guild id"
    );
  }

  const guilds =
    access.guilds.length > 0
      ? Object.fromEntries(
          access.guilds.map((guildId) => [
            guildId,
            {
              ...(access.channels.length > 0
                ? {
                    channels: Object.fromEntries(
                      access.channels.map((channelId) => [channelId, { allow: true }])
                    )
                  }
                : {}),
              ...(access.users.length > 0 ? { users: access.users } : {})
            }
          ])
        )
      : undefined;

  return {
    ...config,
    ...(access.users.length > 0 ? { allowFrom: access.users, dmPolicy: "allowlist" } : {}),
    ...(guilds
      ? {
          groupPolicy: "allowlist",
          guilds
        }
      : {
          groupPolicy: "disabled"
        })
  };
};

const buildOpenClawTelegramConfig = (
  surfaces: ResolvedAgentSurfaces
): Record<string, unknown> => {
  const telegramSurface = surfaces.telegram;
  if (!telegramSurface) {
    return {};
  }

  const config: Record<string, unknown> = {
    enabled: true
  };
  const access = telegramSurface.access;

  if (!access) {
    return config;
  }

  if (access.mode === "pairing") {
    return {
      ...config,
      dmPolicy: "pairing",
      groupPolicy: "disabled"
    };
  }

  if (access.mode === "open") {
    return {
      ...config,
      allowFrom: ["*"],
      dmPolicy: "open",
      groupPolicy: "open",
      groups: {
        "*": {}
      }
    };
  }

  const groups =
    access.chats.length > 0
      ? Object.fromEntries(
          access.chats.map((chatId) => [
            chatId,
            {
              ...(access.users.length > 0 ? { allowFrom: access.users } : {})
            }
          ])
        )
      : undefined;

  return {
    ...config,
    ...(access.users.length > 0 ? { allowFrom: access.users, dmPolicy: "allowlist" } : {}),
    ...(groups
      ? {
          groupPolicy: access.users.length > 0 ? "allowlist" : "open",
          groups
        }
      : {
          groupPolicy: "disabled"
        })
  };
};

const buildOpenClawWhatsAppConfig = (
  surfaces: ResolvedAgentSurfaces
): Record<string, unknown> => {
  const whatsappSurface = surfaces.whatsapp;
  if (!whatsappSurface) {
    return {};
  }

  const config: Record<string, unknown> = {
    enabled: true
  };
  const access = whatsappSurface.access;

  if (!access) {
    return config;
  }

  if (access.mode === "pairing") {
    return {
      ...config,
      dmPolicy: "pairing",
      groupPolicy: "disabled"
    };
  }

  if (access.mode === "open") {
    return {
      ...config,
      allowFrom: ["*"],
      dmPolicy: "open",
      groupPolicy: "open",
      groups: {
        "*": {}
      }
    };
  }

  const groups =
    access.groups.length > 0
      ? Object.fromEntries(access.groups.map((groupId) => [groupId, {}]))
      : undefined;

  return {
    ...config,
    ...(access.users.length > 0 ? { allowFrom: access.users, dmPolicy: "allowlist" } : {}),
    ...(groups
      ? {
          groupPolicy: access.users.length > 0 ? "allowlist" : "open",
          groups
        }
      : {
          groupPolicy: "disabled"
        })
  };
};

const buildOpenClawSlackConfig = (
  surfaces: ResolvedAgentSurfaces
): Record<string, unknown> => {
  const slackSurface = surfaces.slack;
  if (!slackSurface) {
    return {};
  }

  const config: Record<string, unknown> = {
    enabled: true,
    mode: "socket"
  };
  const access = slackSurface.access;

  if (!access) {
    return config;
  }

  if (access.mode === "pairing") {
    return {
      ...config,
      dmPolicy: "pairing",
      groupPolicy: "disabled"
    };
  }

  if (access.mode === "open") {
    return {
      ...config,
      allowFrom: ["*"],
      dmPolicy: "open",
      groupPolicy: "open"
    };
  }

  const channels =
    access.channels.length > 0
      ? Object.fromEntries(
          access.channels.map((channelId) => [
            channelId,
            access.users.length > 0 ? { users: access.users } : {}
          ])
        )
      : undefined;

  return {
    ...config,
    ...(access.users.length > 0 ? { allowFrom: access.users, dmPolicy: "allowlist" } : {}),
    ...(channels
      ? {
          channels,
          groupPolicy: access.users.length > 0 ? "allowlist" : "open"
        }
      : {
          groupPolicy: "disabled"
        })
  };
};

export const buildOpenClawChannelConfig = (
  surfaces: ResolvedAgentSurfaces | undefined
): Record<string, unknown> => {
  if (!surfaces) {
    return {};
  }

  const channels: Record<string, unknown> = {};

  if (surfaces.discord) {
    channels.discord = buildOpenClawDiscordConfig(surfaces);
  }

  if (surfaces.telegram) {
    channels.telegram = buildOpenClawTelegramConfig(surfaces);
  }

  if (surfaces.whatsapp) {
    channels.whatsapp = buildOpenClawWhatsAppConfig(surfaces);
  }

  if (surfaces.slack) {
    channels.slack = buildOpenClawSlackConfig(surfaces);
  }

  return channels;
};

export const buildOpenClawSurfaceEnvBindings = (
  surfaces: ResolvedAgentSurfaces | undefined
): RuntimeContainerConfigEnvBinding[] | undefined => {
  if (!surfaces) {
    return undefined;
  }

  const bindings: RuntimeContainerConfigEnvBinding[] = [];

  if (surfaces.discord) {
    bindings.push({
      envName: surfaces.discord.botTokenSecret,
      jsonPath: "channels.discord.token"
    });
  }

  if (surfaces.telegram) {
    bindings.push({
      envName: surfaces.telegram.botTokenSecret,
      jsonPath: "channels.telegram.botToken"
    });
  }

  if (surfaces.slack) {
    bindings.push(
      {
        envName: surfaces.slack.botTokenSecret,
        jsonPath: "channels.slack.botToken"
      },
      {
        envName: surfaces.slack.appTokenSecret,
        jsonPath: "channels.slack.appToken"
      }
    );
  }

  return bindings.length > 0 ? bindings : undefined;
};

export const assertSupportedOpenClawSurfaces = (
  surfaces: ResolvedAgentSurfaces | undefined
): void => {
  const discordAccess = surfaces?.discord?.access;
  if (discordAccess && discordAccess.mode === "allowlist" && discordAccess.channels.length > 0 && discordAccess.guilds.length !== 1) {
    throw new SpawnfileError(
      "validation_error",
      "OpenClaw Discord channel allowlists require exactly one guild id"
    );
  }
};
