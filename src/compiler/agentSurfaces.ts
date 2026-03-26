import { SurfacesBlock } from "../manifest/index.js";
import {
  DEFAULT_DISCORD_BOT_TOKEN_SECRET,
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

  return Object.keys(resolved).length > 0 ? resolved : undefined;
};

export const listAgentSurfaceSecretNames = (
  surfaces: ResolvedAgentSurfaces | undefined
): string[] =>
  [
    ...(surfaces?.discord ? [surfaces.discord.botTokenSecret] : []),
    ...(surfaces?.telegram ? [surfaces.telegram.botTokenSecret] : [])
  ].sort();
