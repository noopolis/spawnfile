import { chmod, mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readUtf8File, removeDirectory, writeUtf8File } from "../filesystem/index.js";

import { importClaudeCodeAuth, importCodexAuth, importEnvFile } from "./importers.js";
import { ensureAuthProfile, requireAuthProfile, setAuthProfileEnv } from "./profileStore.js";
import type { ResolvedAuthProfile } from "./types.js";

const sources = [
  { kind: "codex", file: "auth.json", importAuth: importCodexAuth },
  { kind: "claude-code", file: ".credentials.json", importAuth: importClaudeCodeAuth }
] as const;
const temporaryDirectories: string[] = [];
const previousSpawnfileHome = process.env.SPAWNFILE_HOME;
let previousUmask: number;

const createTempDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-auth-permissions-"));
  temporaryDirectories.push(directory);
  return directory;
};

const expectMode = async (entry: string, mode: number): Promise<void> => {
  expect((await stat(entry)).mode & 0o7777, entry).toBe(mode);
};

const expectPrivateProfile = async (profile: ResolvedAuthProfile): Promise<void> => {
  await expectMode(profile.authHome, 0o700);
  await expectMode(path.dirname(profile.profileDirectory), 0o700);
  await expectMode(profile.profileDirectory, 0o700);
  await expectMode(profile.profilePath, 0o600);
  for (const source of sources) {
    const entry = profile.imports[source.kind];
    if (!entry) continue;
    await expectMode(path.dirname(entry.path), 0o700);
    await expectMode(entry.path, 0o700);
    await expectMode(path.join(entry.path, source.file), 0o600);
  }
};

describe.skipIf(process.platform === "win32")("private auth imports under umask 022", () => {
  beforeEach(async () => {
    previousUmask = process.umask(0o022);
    process.env.SPAWNFILE_HOME = path.join(await createTempDirectory(), "new-home");
  });

  afterEach(async () => {
    process.umask(previousUmask);
    if (previousSpawnfileHome === undefined) delete process.env.SPAWNFILE_HOME;
    else process.env.SPAWNFILE_HOME = previousSpawnfileHome;
    await Promise.all(temporaryDirectories.splice(0).map(removeDirectory));
  });

  it("creates an empty profile with private directories and metadata", async () => {
    await expectPrivateProfile(await ensureAuthProfile("dev"));
  });

  it.each(sources)("creates private $kind credentials in a clean home", async (source) => {
    const sourceDirectory = await createTempDirectory();
    const sourceFile = path.join(sourceDirectory, source.file);
    const content = '{"token":"first-account"}\n';
    await writeUtf8File(sourceFile, content);
    await chmod(sourceFile, 0o644);

    const profile = await source.importAuth("dev", sourceDirectory);

    await expectMode(path.join(profile.imports[source.kind]!.path, source.file), 0o600);
    await expectPrivateProfile(profile);
    expect(await readUtf8File(path.join(profile.imports[source.kind]!.path, source.file))).toBe(content);
    expect(await readUtf8File(sourceFile)).toBe(content);
    await expectMode(sourceFile, 0o644);
  });

  it.each(sources)("keeps a replaced $kind import private and preserves other auth", async (source) => {
    const sourceDirectory = await createTempDirectory();
    await setAuthProfileEnv("dev", { SERVICE_API_KEY: "existing-env" });
    for (const entry of sources) {
      await writeUtf8File(path.join(sourceDirectory, entry.file), `{"token":"${entry.kind}"}\n`);
      await entry.importAuth("dev", sourceDirectory);
    }
    const before = await requireAuthProfile("dev");
    const directory = before.imports[source.kind]!.path;
    const file = path.join(directory, source.file);
    await chmod(directory, 0o700);
    await chmod(file, 0o600);
    await chmod(before.profilePath, 0o600);
    await writeUtf8File(path.join(sourceDirectory, source.file), '{"token":"replacement-account"}\n');

    const after = await source.importAuth("dev", sourceDirectory);

    await expectMode(file, 0o600);
    await expectPrivateProfile(after);
    expect(after).toEqual(before);
    expect(await requireAuthProfile("dev")).toEqual(before);
    expect(await readUtf8File(file)).toBe('{"token":"replacement-account"}\n');
    const other = sources.find((entry) => entry.kind !== source.kind)!;
    expect(await readUtf8File(path.join(after.imports[other.kind]!.path, other.file))).toBe(
      `{"token":"${other.kind}"}\n`
    );
  });

  it("keeps env credentials private when creating and updating legacy profiles", async () => {
    const envFile = path.join(await createTempDirectory(), ".env");
    await writeUtf8File(envFile, "SERVICE_API_KEY=first\n");
    const initial = await importEnvFile("dev", envFile);
    await expectPrivateProfile(initial);
    await chmod(initial.profilePath, 0o644);
    await chmod(initial.profileDirectory, 0o755);
    await chmod(path.dirname(initial.profileDirectory), 0o755);
    await chmod(initial.authHome, 0o755);
    await writeUtf8File(envFile, "OTHER_API_KEY=second\n");

    const updated = await importEnvFile("dev", envFile);

    await expectPrivateProfile(updated);
    expect(updated.env).toEqual({ SERVICE_API_KEY: "first", OTHER_API_KEY: "second" });
    expect(await requireAuthProfile("dev")).toEqual(updated);
  });
});
