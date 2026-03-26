import { SurfacesBlock } from "../manifest/index.js";
import { DEFAULT_DISCORD_BOT_TOKEN_SECRET } from "../shared/index.js";

import type { ResolvedAgentSurfaces } from "./types.js";

export const resolveAgentSurfaces = (
  surfaces: SurfacesBlock | undefined
): ResolvedAgentSurfaces | undefined => {
  if (!surfaces?.discord) {
    return undefined;
  }

  return {
    discord: {
      ...(surfaces.discord.access
        ? {
            access: {
              channels: [...(surfaces.discord.access.channels ?? [])],
              guilds: [...(surfaces.discord.access.guilds ?? [])],
              mode:
                surfaces.discord.access.mode ??
                "allowlist",
              users: [...(surfaces.discord.access.users ?? [])]
            }
          }
        : {}),
      botTokenSecret:
        surfaces.discord.bot_token_secret ?? DEFAULT_DISCORD_BOT_TOKEN_SECRET
    }
  };
};

export const listAgentSurfaceSecretNames = (
  surfaces: ResolvedAgentSurfaces | undefined
): string[] => {
  if (!surfaces?.discord) {
    return [];
  }

  return [surfaces.discord.botTokenSecret];
};
