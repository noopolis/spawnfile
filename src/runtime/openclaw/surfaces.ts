import type { ResolvedAgentSurfaces } from "../../compiler/types.js";
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

  return channels;
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
