import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  ensurePrivateDirectory,
  readUtf8File,
  removeDirectory,
  writeDurableFile
} from "../filesystem/index.js";
import { SpawnfileError } from "../shared/index.js";

import {
  resolveAuthHome,
  resolveImportedAuthDirectory,
  resolveProfileDirectory,
  resolveProfilePath,
  resolveProfilesRoot
} from "./paths.js";
import { acquireTrainingGrokWritebackLock } from "./training/index.js";
import type { AuthProfile, ImportedAuthKind, ResolvedAuthProfile, SubscriptionRealmBinding } from "./types.js";

const importedAuthEntrySchema = z.object({
  kind: z.enum(["claude-code", "codex", "grok"]),
  relativePath: z.string().min(1)
});

const authProfileSchema = z.object({
  env: z.record(z.string(), z.string()).default({}),
  nativeLogins: z.record(z.string(), z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/u)).optional(),
  imports: z
    .object({
      "claude-code": importedAuthEntrySchema.optional(),
      codex: importedAuthEntrySchema.optional(),
      grok: importedAuthEntrySchema.optional()
    })
    .default({}),
  realms: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/u), z.object({
    realmVolume: z.string().min(1),
    unlockVolume: z.string().min(1),
    homeVolume: z.string().min(1).optional()
  }).strict()).optional(),
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
  ...(profile.nativeLogins ? { nativeLogins: { ...profile.nativeLogins } } : {}),
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
  ...(profile.realms && Object.keys(profile.realms).length > 0 ? { realms: structuredClone(profile.realms) } : {}),
  version: 1
});

const readStoredProfile = async (profileName: string, profilePath: string): Promise<AuthProfile | null> => {
  let fileContent: string;
  try {
    fileContent = await readUtf8File(profilePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

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

  return parsed.data;
};

export const loadAuthProfile = async (profileName: string): Promise<ResolvedAuthProfile | null> => {
  const stored = await readStoredProfile(profileName, resolveProfilePath(profileName));
  return stored && createResolvedAuthProfile(profileName, stored);
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
  return (await loadAuthProfile(profileName)) ?? updateProfile(profileName, current => current);
};

const updateProfile = async (
  profileName: string,
  mutate: (profile: AuthProfile) => AuthProfile | Promise<AuthProfile>
): Promise<ResolvedAuthProfile> => {
  const profileDirectory = resolveProfileDirectory(profileName);
  const profileFile = path.basename(resolveProfilePath(profileName));
  await ensurePrivateDirectory(resolveAuthHome());
  await ensurePrivateDirectory(resolveProfilesRoot());
  await ensurePrivateDirectory(profileDirectory);
  const profilePath = path.join(await realpath(profileDirectory), profileFile);
  // The SQLite lock is keyed by profile.json, separate from any imported credential lock.
  const release = await acquireTrainingGrokWritebackLock(profilePath, 5_000).catch((error: unknown) => {
    if ((error as { errcode?: number }).errcode !== 5) throw error;
    throw new SpawnfileError("runtime_error", `Auth profile ${profileName} is busy. Retry the update.`);
  });
  try {
    const stored = await readStoredProfile(profileName, profilePath);
    const next = await mutate(stored ?? createEmptyProfile());
    if (next !== stored || ((await stat(profilePath)).mode & 0o777) !== 0o600) {
      await writeDurableFile(profilePath, `${JSON.stringify(next, null, 2)}\n`);
    }
    return createResolvedAuthProfile(profileName, next);
  } finally {
    release();
  }
};

export const setAuthProfileEnv = async (
  profileName: string,
  env: Record<string, string>
): Promise<ResolvedAuthProfile> =>
  updateProfile(profileName, current => ({ ...current, env: { ...current.env, ...env } }));

/** Records an engine's volume-held login on the profile (names only, never login bytes). */
export const registerSubscriptionRealm = async (
  profileName: string,
  engine: string,
  binding: SubscriptionRealmBinding
): Promise<ResolvedAuthProfile> =>
  updateProfile(profileName, current => ({ ...current, realms: { ...current.realms, [engine]: { ...binding } } }));

export async function registerNativeLogin(profile: string, key: string, volume: string): Promise<ResolvedAuthProfile> {
  return updateProfile(profile, current => ({ ...current, nativeLogins: { ...current.nativeLogins, [key]: volume } }));
}

export const registerImportedAuth = async (
  profileName: string,
  kind: ImportedAuthKind
): Promise<{ directory: string; profile: ResolvedAuthProfile }> => {
  const importDirectory = resolveImportedAuthDirectory(profileName, kind);
  const relativePath = path.relative(resolveProfileDirectory(profileName), importDirectory);
  const profile = await updateProfile(profileName, async current => {
    await ensurePrivateDirectory(path.dirname(importDirectory));
    // Grok import and writeback share a persistent lock inside this directory.
    // Removing it would let another writer lock a different inode concurrently.
    if (kind !== "grok") await removeDirectory(importDirectory);
    await ensurePrivateDirectory(importDirectory);
    const existing = current.imports[kind];
    if (existing?.kind === kind && existing.relativePath === relativePath) return current;
    return { ...current, imports: { ...current.imports, [kind]: { kind, relativePath } } };
  });
  return { directory: importDirectory, profile };
};
