import path from "node:path";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  copyDirectory,
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
  template?: string;
}

const DEFAULT_AGENT_RUNTIME = "openclaw";

// Bundled example org projects double as `init --template` starting points.
// Resolves to the package's examples/ dir in both dev (src/) and the published
// package (dist/), so examples/ must ship in package.json "files".
const EXAMPLES_ROOT = fileURLToPath(new URL("../../examples", import.meta.url));

export const listInitTemplates = async (): Promise<string[]> => {
  const entries = await readdir(EXAMPLES_ROOT, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
};

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

  if (options.template && (options.team || options.runtime)) {
    throw new SpawnfileError(
      "validation_error",
      "--template cannot be combined with --team or --runtime"
    );
  }

  if (options.team && options.runtime) {
    throw new SpawnfileError(
      "validation_error",
      "Team scaffolds do not accept --runtime"
    );
  }

  // Resolve and validate the template before creating anything, so an unknown
  // template name never leaves an empty directory behind.
  let templateSource: string | undefined;
  if (options.template) {
    const templates = await listInitTemplates();
    if (!templates.includes(options.template)) {
      throw new SpawnfileError(
        "validation_error",
        `Unknown template "${options.template}". Available templates: ${templates.join(", ")}`
      );
    }
    templateSource = path.join(EXAMPLES_ROOT, options.template);
  }

  await ensureDirectory(directory);

  if (templateSource) {
    await copyDirectory(templateSource, directory);
    await ensureGitignoreEntry(directory, `${DEFAULT_OUTPUT_DIRECTORY}/`);
    // Report only the files this template contributed — never pre-existing
    // contents of the target directory.
    const sourceEntries = await readdir(templateSource, { recursive: true, withFileTypes: true });
    const createdFiles = sourceEntries
      .filter((entry) => entry.isFile())
      .map((entry) =>
        path.join(directory, path.relative(templateSource!, path.join(entry.parentPath, entry.name))))
      .sort();
    return { createdFiles, directory };
  }

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
