import type { ResolvedAgentNode, ResolvedAgentSurfaces } from "../../compiler/types.js";
import type {
  ContainerTarget,
  ContainerTargetInput,
  RuntimeContainerConfigEnvBinding
} from "../types.js";
import { SpawnfileError } from "../../shared/index.js";

export const buildTinyClawChannels = (
  surfaces: ResolvedAgentSurfaces | undefined
): { config: Record<string, unknown>; enabled: string[] } => {
  const enabled: string[] = [];
  const config: Record<string, unknown> = {};

  if (surfaces?.discord) {
    enabled.push("discord");
    config.discord = {};
  }

  if (surfaces?.telegram) {
    enabled.push("telegram");
    config.telegram = {};
  }

  return {
    config,
    enabled
  };
};

const resolveSurfaceTokenBinding = (
  inputs: ContainerTargetInput[],
  surfaceName: "discord" | "telegram",
  getEnvName: (node: ResolvedAgentNode) => string | undefined,
  jsonPath: string
): RuntimeContainerConfigEnvBinding[] | undefined => {
  const surfaceLabel = surfaceName[0].toUpperCase() + surfaceName.slice(1);
  const envNames = [
    ...new Set(
      inputs.flatMap((input) => {
        if (input.kind !== "agent" || input.value.kind !== "agent") {
          return [];
        }

        const envName = getEnvName(input.value);
        return envName ? [envName] : [];
      })
    )
  ];

  if (envNames.length === 0) {
    return undefined;
  }

  if (envNames.length > 1) {
    throw new SpawnfileError(
      "validation_error",
      `TinyClaw runtime target declares conflicting ${surfaceLabel} bot token secrets: ${envNames.join(", ")}`
    );
  }

  return [
    {
      envName: envNames[0],
      jsonPath
    }
  ];
};

export const resolveTinyClawSurfaceTokenBindings = (
  inputs: ContainerTargetInput[]
): ContainerTarget["configEnvBindings"] => {
  const bindings = [
    ...(resolveSurfaceTokenBinding(
      inputs,
      "discord",
      (node) => node.surfaces?.discord?.botTokenSecret,
      "channels.discord.bot_token"
    ) ?? []),
    ...(resolveSurfaceTokenBinding(
      inputs,
      "telegram",
      (node) => node.surfaces?.telegram?.botTokenSecret,
      "channels.telegram.bot_token"
    ) ?? [])
  ];

  return bindings.length > 0 ? bindings : undefined;
};

export const assertSupportedTinyClawSurfaces = (
  surfaces: ResolvedAgentSurfaces | undefined
): void => {
  const discordAccess = surfaces?.discord?.access;
  if (discordAccess) {
    if (discordAccess.mode !== "pairing") {
      throw new SpawnfileError(
        "validation_error",
        "TinyClaw Discord only supports pairing access in Spawnfile v0.1"
      );
    }

    if (
      discordAccess.users.length > 0 ||
      discordAccess.guilds.length > 0 ||
      discordAccess.channels.length > 0
    ) {
      throw new SpawnfileError(
        "validation_error",
        "TinyClaw Discord does not support declarative users, guilds, or channels in Spawnfile v0.1"
      );
    }
  }

  const telegramAccess = surfaces?.telegram?.access;
  if (telegramAccess) {
    if (telegramAccess.mode !== "pairing") {
      throw new SpawnfileError(
        "validation_error",
        "TinyClaw Telegram only supports pairing access in Spawnfile v0.1"
      );
    }

    if (telegramAccess.users.length > 0 || telegramAccess.chats.length > 0) {
      throw new SpawnfileError(
        "validation_error",
        "TinyClaw Telegram does not support declarative users or chats in Spawnfile v0.1"
      );
    }
  }
};
