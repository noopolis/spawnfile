import path from "node:path";

import { ensureDirectory, fileExists, writeUtf8File } from "../filesystem/index.js";
import { SpawnfileError } from "../shared/index.js";

export interface InitProjectOptions {
  directory?: string;
  team?: boolean;
}

const agentTemplate = [
  'spawnfile_version: "0.1"',
  "kind: agent",
  "name: my-agent",
  "",
  "runtime: openclaw",
  "",
  "docs:",
  "  system: AGENTS.md",
  "",
  "execution:",
  "  model:",
  "    primary:",
  "      provider: anthropic",
  '      name: claude-sonnet-4-5',
  "  workspace:",
  "    isolation: isolated",
  "  sandbox:",
  "    mode: workspace",
  ""
].join("\n");

const teamTemplate = [
  'spawnfile_version: "0.1"',
  "kind: team",
  "name: my-team",
  "",
  "docs:",
  "  system: TEAM.md",
  "",
  "members: []",
  "",
  "structure:",
  "  mode: swarm",
  ""
].join("\n");

export const initProject = async (
  options: InitProjectOptions = {}
): Promise<{ createdFiles: string[]; directory: string }> => {
  const directory = path.resolve(options.directory ?? process.cwd());
  const manifestPath = path.join(directory, "Spawnfile");

  if (await fileExists(manifestPath)) {
    throw new SpawnfileError(
      "io_error",
      `Refusing to overwrite existing Spawnfile at ${manifestPath}`
    );
  }

  await ensureDirectory(directory);

  const createdFiles: string[] = [manifestPath];
  if (options.team) {
    const teamDocPath = path.join(directory, "TEAM.md");
    await writeUtf8File(manifestPath, teamTemplate);
    await writeUtf8File(teamDocPath, "# Team Instructions\n");
    createdFiles.push(teamDocPath);
  } else {
    const systemDocPath = path.join(directory, "AGENTS.md");
    await writeUtf8File(manifestPath, agentTemplate);
    await writeUtf8File(systemDocPath, "# Operating Instructions\n");
    createdFiles.push(systemDocPath);
  }

  return {
    createdFiles,
    directory
  };
};
