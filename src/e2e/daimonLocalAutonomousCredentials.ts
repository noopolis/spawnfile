import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { removeDirectory } from "../filesystem/index.js";

const PORTABLE_AUTH_ENGINES = ["codex", "grok"] as const;

export interface DaimonLocalAutonomousCredentials {
  directory: string;
  environment: Record<string, string>;
}

const sourceEnvironment = (engine: (typeof PORTABLE_AUTH_ENGINES)[number]): string =>
  `SPAWNFILE_DAIMON_SOURCE_${engine.toUpperCase()}_AUTH`;

export const createDaimonLocalAutonomousCredentials = async (
  homeDirectory = os.homedir()
): Promise<DaimonLocalAutonomousCredentials> => {
  const directory = await mkdtemp(path.join(homeDirectory, ".spawnfile-daimon-local-autonomous-credentials-"));
  try {
    await chmod(directory, 0o700);
    const environment: Record<string, string> = {};
    for (const engine of PORTABLE_AUTH_ENGINES) {
      const file = path.join(directory, `${engine}.json`);
      await writeFile(file, JSON.stringify({ tokens: { access_token: `fixture-${engine}-access`, refresh_token: `fixture-${engine}-refresh` } }), { mode: 0o600 });
      await chmod(file, 0o600);
      environment[sourceEnvironment(engine)] = file;
    }
    const unlock = path.join(directory, "agy-unlock");
    await writeFile(unlock, "fixture-opaque-unlock", { mode: 0o600 });
    await chmod(unlock, 0o600);
    environment.SPAWNFILE_DAIMON_SOURCE_AGY_UNLOCK_SECRET = unlock;
    return { directory, environment };
  } catch (error) {
    await removeDirectory(directory).catch(() => undefined);
    throw error;
  }
};

export const cleanupDaimonLocalAutonomousCredentials = async (directory: string): Promise<void> => {
  await removeDirectory(directory);
};
