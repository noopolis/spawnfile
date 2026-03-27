import { SurfacesBlock } from "../manifest/index.js";
import {
  DEFAULT_DISCORD_BOT_TOKEN_SECRET,
  DEFAULT_SLACK_APP_TOKEN_SECRET,
  DEFAULT_SLACK_BOT_TOKEN_SECRET,
  DEFAULT_TELEGRAM_BOT_TOKEN_SECRET
} from "../shared/index.js";

import type { ResolvedAgentSurfaces } from "./types.js";

export const resolveAgentSurfaces = (
  surfaces: SurfacesBlock | undefined
): ResolvedAgentSurfaces | undefined => {
  if (!surfaces) {
    return undefined;
  }

  const resolved: ResolvedAgentSurfaces = {};

  if (surfaces.discord) {
    resolved.discord = {
      ...(surfaces.discord.access
        ? {
            access: {
              channels: [...(surfaces.discord.access.channels ?? [])],
              guilds: [...(surfaces.discord.access.guilds ?? [])],
              mode: surfaces.discord.access.mode ?? "allowlist",
              users: [...(surfaces.discord.access.users ?? [])]
            }
          }
        : {}),
      botTokenSecret:
        surfaces.discord.bot_token_secret ?? DEFAULT_DISCORD_BOT_TOKEN_SECRET
    };
  }

  if (surfaces.telegram) {
    resolved.telegram = {
      ...(surfaces.telegram.access
        ? {
            access: {
              chats: [...(surfaces.telegram.access.chats ?? [])],
              mode: surfaces.telegram.access.mode ?? "allowlist",
              users: [...(surfaces.telegram.access.users ?? [])]
            }
          }
        : {}),
      botTokenSecret:
        surfaces.telegram.bot_token_secret ?? DEFAULT_TELEGRAM_BOT_TOKEN_SECRET
    };
  }

  if (surfaces.whatsapp) {
    resolved.whatsapp = surfaces.whatsapp.access
      ? {
          access: {
            groups: [...(surfaces.whatsapp.access.groups ?? [])],
            mode: surfaces.whatsapp.access.mode ?? "allowlist",
            users: [...(surfaces.whatsapp.access.users ?? [])]
          }
        }
      : {};
  }

  if (surfaces.slack) {
    resolved.slack = {
      ...(surfaces.slack.access
        ? {
            access: {
              channels: [...(surfaces.slack.access.channels ?? [])],
              mode: surfaces.slack.access.mode ?? "allowlist",
              users: [...(surfaces.slack.access.users ?? [])]
            }
          }
        : {}),
      appTokenSecret:
        surfaces.slack.app_token_secret ?? DEFAULT_SLACK_APP_TOKEN_SECRET,
      botTokenSecret:
        surfaces.slack.bot_token_secret ?? DEFAULT_SLACK_BOT_TOKEN_SECRET
    };
  }

  return Object.keys(resolved).length > 0 ? resolved : undefined;
};

export const listAgentSurfaceSecretNames = (
  surfaces: ResolvedAgentSurfaces | undefined
): string[] =>
  [
    ...(surfaces?.discord ? [surfaces.discord.botTokenSecret] : []),
    ...(surfaces?.slack
      ? [surfaces.slack.appTokenSecret, surfaces.slack.botTokenSecret]
      : []),
    ...(surfaces?.telegram ? [surfaces.telegram.botTokenSecret] : [])
  ].sort();
