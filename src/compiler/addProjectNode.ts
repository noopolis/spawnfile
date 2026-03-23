import path from "node:path";

import {
  fileExists,
  getManifestPath,
  getProjectRoot,
  writeUtf8File
} from "../filesystem/index.js";
import {
  type AgentManifest,
  type ManifestMember,
  type TeamManifest,
  isAgentManifest,
  isTeamManifest,
  loadManifest,
  renderSpawnfile
} from "../manifest/index.js";
import { SpawnfileError } from "../shared/index.js";

import { initProject } from "./initProject.js";

export interface AddAgentProjectOptions {
  id: string;
  path?: string;
  runtime?: string;
}

export interface AddSubagentProjectOptions {
  id: string;
  path?: string;
}

export interface AddTeamProjectOptions {
  id: string;
  path?: string;
}

export interface AddProjectNodeResult {
  createdFiles: string[];
  targetDirectory: string;
  updatedFiles: string[];
}

const assertAddableId = (id: string): void => {
  if (id.trim().length === 0) {
    throw new SpawnfileError("validation_error", "Child id must not be empty");
  }

  if (/\s/.test(id)) {
    throw new SpawnfileError("validation_error", `Child id must not contain whitespace: ${id}`);
  }

  if (/[\\/]/.test(id)) {
    throw new SpawnfileError("validation_error", `Child id must not contain path separators: ${id}`);
  }
};

const resolveTargetManifestPath = (inputPath?: string): string =>
  getManifestPath(path.resolve(inputPath ?? process.cwd()));

const assertChildDirectoryAvailable = async (childDirectory: string): Promise<void> => {
  if (await fileExists(childDirectory)) {
    throw new SpawnfileError(
      "io_error",
      `Refusing to overwrite existing child directory at ${childDirectory}`
    );
  }
};

const assertUniqueRef = (refs: Array<{ id: string }>, id: string, label: string): void => {
  if (refs.some((entry) => entry.id === id)) {
    throw new SpawnfileError("validation_error", `Duplicate ${label} id: ${id}`);
  }
};

const updateParentManifest = async (
  manifestPath: string,
  manifest: AgentManifest | TeamManifest
): Promise<void> => {
  await writeUtf8File(manifestPath, renderSpawnfile(manifest));
};

const getRuntimeName = (runtime: AgentManifest["runtime"]): string | undefined =>
  typeof runtime === "string" ? runtime : runtime?.name;

const createTeamMember = (id: string, relativeRef: string): ManifestMember => ({
  id,
  ref: relativeRef
});

export const addAgentProject = async (
  options: AddAgentProjectOptions
): Promise<AddProjectNodeResult> => {
  assertAddableId(options.id);

  const manifestPath = resolveTargetManifestPath(options.path);
  const loadedManifest = await loadManifest(manifestPath);
  if (!isTeamManifest(loadedManifest.manifest)) {
    throw new SpawnfileError("validation_error", "spawnfile add agent only works on team projects");
  }

  assertUniqueRef(loadedManifest.manifest.members, options.id, "member");

  const targetDirectory = getProjectRoot(manifestPath);
  const childDirectory = path.join(targetDirectory, "agents", options.id);
  await assertChildDirectoryAvailable(childDirectory);

  const child = await initProject({
    directory: childDirectory,
    runtime: options.runtime
  });

  await updateParentManifest(manifestPath, {
    ...loadedManifest.manifest,
    members: [
      ...loadedManifest.manifest.members,
      createTeamMember(options.id, `./agents/${options.id}`)
    ]
  });

  return {
    createdFiles: child.createdFiles,
    targetDirectory,
    updatedFiles: [manifestPath]
  };
};

export const addSubagentProject = async (
  options: AddSubagentProjectOptions
): Promise<AddProjectNodeResult> => {
  assertAddableId(options.id);

  const manifestPath = resolveTargetManifestPath(options.path);
  const loadedManifest = await loadManifest(manifestPath);
  if (!isAgentManifest(loadedManifest.manifest)) {
    throw new SpawnfileError(
      "validation_error",
      "spawnfile add subagent only works on agent projects"
    );
  }

  assertUniqueRef(loadedManifest.manifest.subagents ?? [], options.id, "subagent");

  const runtimeName = getRuntimeName(loadedManifest.manifest.runtime);
  if (!runtimeName) {
    throw new SpawnfileError(
      "validation_error",
      "Agent must declare a runtime before adding subagents"
    );
  }

  const targetDirectory = getProjectRoot(manifestPath);
  const childDirectory = path.join(targetDirectory, "subagents", options.id);
  await assertChildDirectoryAvailable(childDirectory);

  const child = await initProject({
    directory: childDirectory,
    runtime: runtimeName
  });

  await updateParentManifest(manifestPath, {
    ...loadedManifest.manifest,
    subagents: [
      ...(loadedManifest.manifest.subagents ?? []),
      {
        id: options.id,
        ref: `./subagents/${options.id}`
      }
    ]
  });

  return {
    createdFiles: child.createdFiles,
    targetDirectory,
    updatedFiles: [manifestPath]
  };
};

export const addTeamProject = async (
  options: AddTeamProjectOptions
): Promise<AddProjectNodeResult> => {
  assertAddableId(options.id);

  const manifestPath = resolveTargetManifestPath(options.path);
  const loadedManifest = await loadManifest(manifestPath);
  if (!isTeamManifest(loadedManifest.manifest)) {
    throw new SpawnfileError("validation_error", "spawnfile add team only works on team projects");
  }

  assertUniqueRef(loadedManifest.manifest.members, options.id, "member");

  const targetDirectory = getProjectRoot(manifestPath);
  const childDirectory = path.join(targetDirectory, "teams", options.id);
  await assertChildDirectoryAvailable(childDirectory);

  const child = await initProject({
    directory: childDirectory,
    team: true
  });

  await updateParentManifest(manifestPath, {
    ...loadedManifest.manifest,
    members: [
      ...loadedManifest.manifest.members,
      createTeamMember(options.id, `./teams/${options.id}`)
    ]
  });

  return {
    createdFiles: child.createdFiles,
    targetDirectory,
    updatedFiles: [manifestPath]
  };
};
