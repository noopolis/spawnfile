import type {
  AgentManifest,
  DiscordSurface,
  DiscordSurfaceAccess,
  SlackSurface,
  SlackSurfaceAccess,
  SurfacesBlock,
  TeamManifest,
  TelegramSurface,
  TelegramSurfaceAccess,
  WhatsAppSurface,
  WhatsAppSurfaceAccess
} from "../manifest/index.js";
import { SpawnfileError } from "../shared/index.js";

import { resolveAgentSurfaces } from "./agentSurfaces.js";
import { assertRuntimeSupportsAgentSurfaces } from "./surfaceSupport.js";

type ProjectManifest = AgentManifest | TeamManifest;

export type SurfaceAccessMode = "allowlist" | "open" | "pairing";
export const PORTABLE_SURFACE_NAMES = ["discord", "slack", "telegram", "whatsapp"] as const;
export type SurfaceName = (typeof PORTABLE_SURFACE_NAMES)[number];

export interface ProjectSurfaceSecretOptions {
  appTokenSecret?: string;
  botTokenSecret?: string;
}

export interface AddProjectSurfaceOptions extends ProjectSurfaceSecretOptions {
  path?: string;
  recursive?: boolean;
  surface: string;
}

export interface ProjectSurfaceAccessOptions {
  channels?: string[];
  chats?: string[];
  groups?: string[];
  guilds?: string[];
  mode: SurfaceAccessMode;
  path?: string;
  recursive?: boolean;
  surface: string;
  users?: string[];
}

export interface RemoveProjectSurfaceOptions {
  path?: string;
  recursive?: boolean;
  surface: string;
}

export interface ShowProjectSurfacesOptions {
  path?: string;
  recursive?: boolean;
}

export interface ProjectSurfaceSummary {
  kind: "agent" | "team";
  manifestPath: string;
  name: string;
  surfaces?: SurfacesBlock;
}

export interface ProjectSurfaceSummariesResult {
  entries: ProjectSurfaceSummary[];
}

export interface UpdateProjectSurfacesResult {
  updatedFiles: string[];
}

export const TEAM_SURFACE_COMMAND_ERROR =
  "spawnfile surface commands only write agent manifests; use --recursive to update descendant agents of a team project";

export const getRuntimeName = (runtime: AgentManifest["runtime"]): string | undefined =>
  typeof runtime === "string" ? runtime : runtime?.name;

export const resolvePortableSurfaceName = (surface: string): SurfaceName => {
  if (!(PORTABLE_SURFACE_NAMES as readonly string[]).includes(surface)) {
    throw new SpawnfileError(
      "validation_error",
      `Unsupported portable surface ${surface}; expected one of: ${PORTABLE_SURFACE_NAMES.join(", ")}`
    );
  }

  return surface as SurfaceName;
};

export const assertSurfaceMutationAllowed = (
  manifest: ProjectManifest,
  recursive: boolean
): manifest is AgentManifest => {
  if (manifest.kind === "agent") {
    return true;
  }

  if (recursive) {
    return false;
  }

  throw new SpawnfileError("validation_error", TEAM_SURFACE_COMMAND_ERROR);
};

const normalizeEntries = (values: string[] | undefined): string[] | undefined => {
  const normalized = [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();
  return normalized.length > 0 ? normalized : undefined;
};

const validateSecrets = (
  surface: SurfaceName,
  options: ProjectSurfaceSecretOptions
): void => {
  if (options.appTokenSecret && surface !== "slack") {
    throw new SpawnfileError(
      "validation_error",
      "--app-token-secret is only valid for slack surfaces"
    );
  }

  if (options.botTokenSecret && !["discord", "slack", "telegram"].includes(surface)) {
    throw new SpawnfileError(
      "validation_error",
      `--bot-token-secret is not valid for ${surface} surfaces`
    );
  }
};

const buildDiscordAccess = (
  options: ProjectSurfaceAccessOptions
): DiscordSurfaceAccess => {
  const users = normalizeEntries(options.users);
  const guilds = normalizeEntries(options.guilds);
  const channels = normalizeEntries(options.channels);
  const hasAllowlistEntries = Boolean(users || guilds || channels);

  if (options.mode === "allowlist" && !hasAllowlistEntries) {
    throw new SpawnfileError(
      "validation_error",
      "discord allowlist access requires at least one --user, --guild, or --channel"
    );
  }

  if (options.mode !== "allowlist" && hasAllowlistEntries) {
    throw new SpawnfileError(
      "validation_error",
      "discord allowlist entries are only valid with --mode allowlist"
    );
  }

  return {
    ...(channels ? { channels } : {}),
    ...(guilds ? { guilds } : {}),
    mode: options.mode,
    ...(users ? { users } : {})
  };
};

const buildTelegramAccess = (
  options: ProjectSurfaceAccessOptions
): TelegramSurfaceAccess => {
  const users = normalizeEntries(options.users);
  const chats = normalizeEntries(options.chats);
  const hasAllowlistEntries = Boolean(users || chats);

  if (options.mode === "allowlist" && !hasAllowlistEntries) {
    throw new SpawnfileError(
      "validation_error",
      "telegram allowlist access requires at least one --user or --chat"
    );
  }

  if (options.mode !== "allowlist" && hasAllowlistEntries) {
    throw new SpawnfileError(
      "validation_error",
      "telegram allowlist entries are only valid with --mode allowlist"
    );
  }

  return {
    ...(chats ? { chats } : {}),
    mode: options.mode,
    ...(users ? { users } : {})
  };
};

const buildWhatsAppAccess = (
  options: ProjectSurfaceAccessOptions
): WhatsAppSurfaceAccess => {
  const users = normalizeEntries(options.users);
  const groups = normalizeEntries(options.groups);
  const hasAllowlistEntries = Boolean(users || groups);

  if (options.mode === "allowlist" && !hasAllowlistEntries) {
    throw new SpawnfileError(
      "validation_error",
      "whatsapp allowlist access requires at least one --user or --group"
    );
  }

  if (options.mode !== "allowlist" && hasAllowlistEntries) {
    throw new SpawnfileError(
      "validation_error",
      "whatsapp allowlist entries are only valid with --mode allowlist"
    );
  }

  return {
    ...(groups ? { groups } : {}),
    mode: options.mode,
    ...(users ? { users } : {})
  };
};

const buildSlackAccess = (
  options: ProjectSurfaceAccessOptions
): SlackSurfaceAccess => {
  const users = normalizeEntries(options.users);
  const channels = normalizeEntries(options.channels);
  const hasAllowlistEntries = Boolean(users || channels);

  if (options.mode === "allowlist" && !hasAllowlistEntries) {
    throw new SpawnfileError(
      "validation_error",
      "slack allowlist access requires at least one --user or --channel"
    );
  }

  if (options.mode !== "allowlist" && hasAllowlistEntries) {
    throw new SpawnfileError(
      "validation_error",
      "slack allowlist entries are only valid with --mode allowlist"
    );
  }

  return {
    ...(channels ? { channels } : {}),
    mode: options.mode,
    ...(users ? { users } : {})
  };
};

const buildSurfaceAccess = (
  options: ProjectSurfaceAccessOptions
):
  | DiscordSurfaceAccess
  | SlackSurfaceAccess
  | TelegramSurfaceAccess
  | WhatsAppSurfaceAccess => {
  const surface = resolvePortableSurfaceName(options.surface);

  switch (surface) {
    case "discord":
      return buildDiscordAccess(options);
    case "telegram":
      return buildTelegramAccess(options);
    case "whatsapp":
      return buildWhatsAppAccess(options);
    case "slack":
      return buildSlackAccess(options);
  }
};

export const upsertSurface = (
  surfaces: SurfacesBlock | undefined,
  options: AddProjectSurfaceOptions
): SurfacesBlock => {
  const surface = resolvePortableSurfaceName(options.surface);
  validateSecrets(surface, options);

  const nextSurfaces: SurfacesBlock = { ...(surfaces ?? {}) };

  switch (surface) {
    case "discord":
      nextSurfaces.discord = {
        ...(surfaces?.discord ?? {}),
        ...(options.botTokenSecret ? { bot_token_secret: options.botTokenSecret } : {})
      } satisfies DiscordSurface;
      break;
    case "telegram":
      nextSurfaces.telegram = {
        ...(surfaces?.telegram ?? {}),
        ...(options.botTokenSecret ? { bot_token_secret: options.botTokenSecret } : {})
      } satisfies TelegramSurface;
      break;
    case "whatsapp":
      nextSurfaces.whatsapp = {
        ...(surfaces?.whatsapp ?? {})
      } satisfies WhatsAppSurface;
      break;
    case "slack":
      nextSurfaces.slack = {
        ...(surfaces?.slack ?? {}),
        ...(options.appTokenSecret ? { app_token_secret: options.appTokenSecret } : {}),
        ...(options.botTokenSecret ? { bot_token_secret: options.botTokenSecret } : {})
      } satisfies SlackSurface;
      break;
  }

  return nextSurfaces;
};

export const updateSurfaceAccess = (
  surfaces: SurfacesBlock | undefined,
  options: ProjectSurfaceAccessOptions,
  manifestPath: string,
  recursive: boolean
): SurfacesBlock | null => {
  const surface = resolvePortableSurfaceName(options.surface);
  const nextSurfaces: SurfacesBlock = { ...(surfaces ?? {}) };
  const access = buildSurfaceAccess({ ...options, surface });

  switch (surface) {
    case "discord":
      if (!nextSurfaces.discord) {
        if (recursive) {
          return null;
        }
        throw new SpawnfileError(
          "validation_error",
          `Surface discord is not declared in ${manifestPath}; use spawnfile surface add discord first`
        );
      }
      nextSurfaces.discord = { ...nextSurfaces.discord, access: access as DiscordSurfaceAccess };
      break;
    case "telegram":
      if (!nextSurfaces.telegram) {
        if (recursive) {
          return null;
        }
        throw new SpawnfileError(
          "validation_error",
          `Surface telegram is not declared in ${manifestPath}; use spawnfile surface add telegram first`
        );
      }
      nextSurfaces.telegram = { ...nextSurfaces.telegram, access: access as TelegramSurfaceAccess };
      break;
    case "whatsapp":
      if (!nextSurfaces.whatsapp) {
        if (recursive) {
          return null;
        }
        throw new SpawnfileError(
          "validation_error",
          `Surface whatsapp is not declared in ${manifestPath}; use spawnfile surface add whatsapp first`
        );
      }
      nextSurfaces.whatsapp = { ...nextSurfaces.whatsapp, access: access as WhatsAppSurfaceAccess };
      break;
    case "slack":
      if (!nextSurfaces.slack) {
        if (recursive) {
          return null;
        }
        throw new SpawnfileError(
          "validation_error",
          `Surface slack is not declared in ${manifestPath}; use spawnfile surface add slack first`
        );
      }
      nextSurfaces.slack = { ...nextSurfaces.slack, access: access as SlackSurfaceAccess };
      break;
  }

  return nextSurfaces;
};

export const removeSurface = (
  surfaces: SurfacesBlock | undefined,
  surface: string
): SurfacesBlock | undefined => {
  const surfaceName = resolvePortableSurfaceName(surface);
  if (!surfaces?.[surfaceName]) {
    return surfaces;
  }

  const nextSurfaces = { ...surfaces };
  delete nextSurfaces[surfaceName];
  return Object.keys(nextSurfaces).length > 0 ? nextSurfaces : undefined;
};

export const validateAgentSurfaceSupport = (manifest: AgentManifest): void => {
  const runtimeName = getRuntimeName(manifest.runtime);
  if (!runtimeName) {
    return;
  }

  assertRuntimeSupportsAgentSurfaces(
    runtimeName,
    resolveAgentSurfaces(manifest.surfaces),
    manifest.name
  );
};
