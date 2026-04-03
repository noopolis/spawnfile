import type { ResolvedAgentSurfaces } from "../../compiler/types.js";
import type { RuntimeContainerConfigEnvBinding } from "../types.js";
import { SpawnfileError } from "../../shared/index.js";
import { PICOCLAW_INTERNAL_PICO_TOKEN } from "./pico.js";

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

  if (surfaces.whatsapp) {
    channels.whatsapp = {
      ...(surfaces.whatsapp.access?.mode === "allowlist"
        ? { allow_from: surfaces.whatsapp.access.users }
        : {}),
      enabled: true,
      use_native: true
    };
  }

  if (surfaces.slack) {
    channels.slack = {
      ...(surfaces.slack.access?.mode === "allowlist"
        ? { allow_from: surfaces.slack.access.users }
        : {}),
      enabled: true,
      group_trigger: {
        mention_only: true
      }
    };
  }

  if (surfaces.moltnet) {
    channels.pico = {
      allow_token_query: true,
      enabled: true,
      token: PICOCLAW_INTERNAL_PICO_TOKEN
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

  if (surfaces.slack) {
    bindings.push(
      {
        envName: surfaces.slack.botTokenSecret,
        jsonPath: "channels.slack.bot_token"
      },
      {
        envName: surfaces.slack.appTokenSecret,
        jsonPath: "channels.slack.app_token"
      }
    );
  }

  return bindings.length > 0 ? bindings : undefined;
};

export const assertSupportedPicoClawSurfaces = (
  surfaces: ResolvedAgentSurfaces | undefined
): void => {
  // HTTP surface is accepted — the surface router provides it for team coordination.
  // PicoClaw does not natively serve the portable HTTP contract but the router bridges to it.

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

  const whatsappAccess = surfaces?.whatsapp?.access;
  if (whatsappAccess) {
    if (whatsappAccess.mode === "pairing") {
      throw new SpawnfileError(
        "validation_error",
        "PicoClaw WhatsApp does not support pairing access"
      );
    }

    if (whatsappAccess.groups.length > 0) {
      throw new SpawnfileError(
        "validation_error",
        "PicoClaw WhatsApp only supports user allowlists in Spawnfile v0.1"
      );
    }
  }

  const slackAccess = surfaces?.slack?.access;
  if (slackAccess) {
    if (slackAccess.mode === "pairing") {
      throw new SpawnfileError(
        "validation_error",
        "PicoClaw Slack does not support pairing access"
      );
    }

    if (slackAccess.channels.length > 0) {
      throw new SpawnfileError(
        "validation_error",
        "PicoClaw Slack only supports user allowlists in Spawnfile v0.1"
      );
    }
  }
};
