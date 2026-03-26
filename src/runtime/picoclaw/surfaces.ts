import type { ResolvedAgentSurfaces } from "../../compiler/types.js";
import type { RuntimeContainerConfigEnvBinding } from "../types.js";
import { SpawnfileError } from "../../shared/index.js";

export const buildPicoClawChannelConfig = (
  surfaces: ResolvedAgentSurfaces | undefined
): Record<string, unknown> => {
  if (!surfaces) {
    return {};
  }

  const channels: Record<string, unknown> = {};

  if (surfaces.discord) {
    channels.discord = {
      ...(surfaces.discord.access?.mode === "allowlist"
        ? { allow_from: surfaces.discord.access.users }
        : {}),
      enabled: true,
      mention_only: true
    };
  }

  if (surfaces.telegram) {
    channels.telegram = {
      ...(surfaces.telegram.access?.mode === "allowlist"
        ? { allow_from: surfaces.telegram.access.users }
        : {}),
      enabled: true
    };
  }

  return channels;
};

export const buildPicoClawSurfaceEnvBindings = (
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
      jsonPath: "channels.telegram.token"
    });
  }

  return bindings.length > 0 ? bindings : undefined;
};

export const assertSupportedPicoClawSurfaces = (
  surfaces: ResolvedAgentSurfaces | undefined
): void => {
  const discordAccess = surfaces?.discord?.access;
  if (discordAccess) {
    if (discordAccess.mode === "pairing") {
      throw new SpawnfileError(
        "validation_error",
        "PicoClaw Discord does not support pairing access"
      );
    }

    if (discordAccess.guilds.length > 0 || discordAccess.channels.length > 0) {
      throw new SpawnfileError(
        "validation_error",
        "PicoClaw Discord only supports user allowlists in Spawnfile v0.1"
      );
    }
  }

  const telegramAccess = surfaces?.telegram?.access;
  if (telegramAccess) {
    if (telegramAccess.mode === "pairing") {
      throw new SpawnfileError(
        "validation_error",
        "PicoClaw Telegram does not support pairing access"
      );
    }

    if (telegramAccess.chats.length > 0) {
      throw new SpawnfileError(
        "validation_error",
        "PicoClaw Telegram only supports user allowlists in Spawnfile v0.1"
      );
    }
  }
};
