import path from "node:path";

import {
  ensureDirectory,
  ensureGitignoreEntry,
  fileExists,
  writeUtf8File
} from "../filesystem/index.js";
import { createTeamScaffoldManifest, renderSpawnfile } from "../manifest/index.js";
import { getRuntimeAdapter } from "../runtime/index.js";
import { DEFAULT_OUTPUT_DIRECTORY, SpawnfileError } from "../shared/index.js";

export interface InitProjectOptions {
  directory?: string;
  runtime?: string;
  team?: boolean;
}

const DEFAULT_AGENT_RUNTIME = "openclaw";

export const initProject = async (
  options: InitProjectOptions = {}
): Promise<{ createdFiles: string[]; directory: string }> => {
  const directory = path.resolve(options.directory ?? process.cwd());
  const manifestPath = path.join(directory, "Spawnfile");
  const runtimeName = options.runtime ?? DEFAULT_AGENT_RUNTIME;

  if (await fileExists(manifestPath)) {
    throw new SpawnfileError(
      "io_error",
      `Refusing to overwrite existing Spawnfile at ${manifestPath}`
    );
  }

  if (options.team && options.runtime) {
    throw new SpawnfileError(
      "validation_error",
      "Team scaffolds do not accept --runtime"
    );
  }

  await ensureDirectory(directory);

  const createdFiles: string[] = [manifestPath];
  const gitignorePath = path.join(directory, ".gitignore");
  const hadGitignore = await fileExists(gitignorePath);
  if ((await ensureGitignoreEntry(directory, `${DEFAULT_OUTPUT_DIRECTORY}/`)) && !hadGitignore) {
    createdFiles.push(path.join(directory, ".gitignore"));
  }

  if (options.team) {
    const teamDocPath = path.join(directory, "TEAM.md");
    await writeUtf8File(manifestPath, renderSpawnfile(createTeamScaffoldManifest()));
    await writeUtf8File(teamDocPath, "# Team Instructions\n");
    createdFiles.push(teamDocPath);
  } else {
    const scaffold = getRuntimeAdapter(runtimeName).scaffoldAgentProject?.();
    if (!scaffold) {
      throw new SpawnfileError(
        "runtime_error",
        `Runtime ${runtimeName} does not provide an init scaffold`
      );
    }

    await writeUtf8File(manifestPath, renderSpawnfile(scaffold.manifest));

    for (const file of scaffold.files) {
      const targetPath = path.join(directory, file.path);
      await writeUtf8File(targetPath, file.content);
      createdFiles.push(targetPath);
    }
  }

  return {
    createdFiles,
    directory
  };
};
