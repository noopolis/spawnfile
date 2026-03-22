import path from "node:path";

import { z } from "zod";

import {
  ensureDirectory,
  fileExists,
  readUtf8File,
  removeDirectory,
  writeUtf8File
} from "../filesystem/index.js";
import { SpawnfileError } from "../shared/index.js";

import {
  resolveAuthHome,
  resolveImportedAuthDirectory,
  resolveProfileDirectory,
  resolveProfilePath
} from "./paths.js";
import type { AuthProfile, ImportedAuthKind, ResolvedAuthProfile } from "./types.js";

const importedAuthEntrySchema = z.object({
  kind: z.enum(["claude-code", "codex"]),
  relativePath: z.string().min(1)
});

const authProfileSchema = z.object({
  env: z.record(z.string(), z.string()).default({}),
  imports: z
    .object({
      "claude-code": importedAuthEntrySchema.optional(),
      codex: importedAuthEntrySchema.optional()
    })
    .default({}),
  version: z.literal(1)
});

const createEmptyProfile = (): AuthProfile => ({
  env: {},
  imports: {},
  version: 1
});

export const createResolvedAuthProfile = (
  profileName: string,
  profile: AuthProfile
): ResolvedAuthProfile => ({
  authHome: resolveAuthHome(),
  env: { ...profile.env },
  imports: Object.fromEntries(
    Object.entries(profile.imports).map(([kind, entry]) => [
      kind,
      {
        kind: entry.kind,
        path: path.join(resolveProfileDirectory(profileName), entry.relativePath)
      }
    ])
  ) as ResolvedAuthProfile["imports"],
  name: profileName,
  profileDirectory: resolveProfileDirectory(profileName),
  profilePath: resolveProfilePath(profileName),
  version: 1
});

export const loadAuthProfile = async (
  profileName: string
): Promise<ResolvedAuthProfile | null> => {
  const profilePath = resolveProfilePath(profileName);
  if (!(await fileExists(profilePath))) {
    return null;
  }

  const fileContent = await readUtf8File(profilePath);
  let raw: unknown;
  try {
    raw = JSON.parse(fileContent) as unknown;
  } catch (error) {
    throw new SpawnfileError(
      "validation_error",
      `Invalid auth profile ${profileName}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const parsed = authProfileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SpawnfileError(
      "validation_error",
      `Invalid auth profile ${profileName}: ${parsed.error.issues[0]?.message ?? "unknown error"}`
    );
  }

  return createResolvedAuthProfile(profileName, parsed.data);
};

export const requireAuthProfile = async (
  profileName: string
): Promise<ResolvedAuthProfile> => {
  const profile = await loadAuthProfile(profileName);
  if (profile) {
    return profile;
  }

  throw new SpawnfileError("validation_error", `Auth profile does not exist: ${profileName}`);
};

export const ensureAuthProfile = async (
  profileName: string
): Promise<ResolvedAuthProfile> => {
  const existing = await loadAuthProfile(profileName);
  if (existing) {
    return existing;
  }

  const profileDirectory = resolveProfileDirectory(profileName);
  await ensureDirectory(profileDirectory);
  await writeUtf8File(resolveProfilePath(profileName), `${JSON.stringify(createEmptyProfile(), null, 2)}\n`);
  return createResolvedAuthProfile(profileName, createEmptyProfile());
};

const writeProfile = async (profileName: string, profile: AuthProfile): Promise<ResolvedAuthProfile> => {
  const profileDirectory = resolveProfileDirectory(profileName);
  await ensureDirectory(profileDirectory);
  await writeUtf8File(resolveProfilePath(profileName), `${JSON.stringify(profile, null, 2)}\n`);
  return createResolvedAuthProfile(profileName, profile);
};

export const setAuthProfileEnv = async (
  profileName: string,
  env: Record<string, string>
): Promise<ResolvedAuthProfile> => {
  const current = (await loadAuthProfile(profileName)) ?? (await ensureAuthProfile(profileName));
  return writeProfile(profileName, {
    env: {
      ...current.env,
      ...env
    },
    imports: Object.fromEntries(
      Object.entries(current.imports).map(([kind, entry]) => [
        kind,
        {
          kind: entry.kind,
          relativePath: path.relative(current.profileDirectory, entry.path)
        }
      ])
    ) as AuthProfile["imports"],
    version: 1
  });
};

export const registerImportedAuth = async (
  profileName: string,
  kind: ImportedAuthKind
): Promise<{ directory: string; profile: ResolvedAuthProfile }> => {
  const current = (await loadAuthProfile(profileName)) ?? (await ensureAuthProfile(profileName));
  const importDirectory = resolveImportedAuthDirectory(profileName, kind);
  await removeDirectory(importDirectory);
  await ensureDirectory(importDirectory);

  const nextProfile: AuthProfile = {
    env: { ...current.env },
    imports: {
      ...Object.fromEntries(
        Object.entries(current.imports).map(([entryKind, entry]) => [
          entryKind,
          {
            kind: entry.kind,
            relativePath: path.relative(current.profileDirectory, entry.path)
          }
        ])
      ),
      [kind]: {
        kind,
        relativePath: path.relative(current.profileDirectory, importDirectory)
      }
    },
    version: 1
  };

  return {
    directory: importDirectory,
    profile: await writeProfile(profileName, nextProfile)
  };
};
