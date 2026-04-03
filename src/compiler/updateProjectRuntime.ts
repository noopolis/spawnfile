import path from "node:path";

import {
  getCanonicalManifestPath,
  getManifestPath,
  getProjectRoot,
  writeUtf8File
} from "../filesystem/index.js";
import type { AgentManifest, TeamManifest } from "../manifest/index.js";
import { loadManifest, renderSpawnfile } from "../manifest/index.js";
import { assertRuntimeCanCompile } from "../runtime/index.js";
import { SpawnfileError } from "../shared/index.js";

import { assertRuntimeSupportsExecutionModelAuth } from "./modelAuth.js";
import { validateAgentSurfaceSupport } from "./surfaceDefinitions.js";

type ProjectManifest = AgentManifest | TeamManifest;

export interface ProjectRuntimeOptions {
  path?: string;
  recursive?: boolean;
  runtime: string;
}

export interface UpdateProjectRuntimeResult {
  updatedFiles: string[];
}

const TEAM_RUNTIME_COMMAND_ERROR =
  "spawnfile runtime commands only write agent manifests; use --recursive to update descendant agents of a team project";

const resolveTargetManifestPath = (inputPath?: string): string =>
  getManifestPath(path.resolve(inputPath ?? process.cwd()));

const collectManifestPaths = async (
  manifestPath: string,
  recursive: boolean,
  visited = new Set<string>()
): Promise<string[]> => {
  const canonicalPath = getCanonicalManifestPath(manifestPath);
  if (visited.has(canonicalPath)) {
    return [];
  }

  visited.add(canonicalPath);
  if (!recursive) {
    return [canonicalPath];
  }

  const loadedManifest = await loadManifest(canonicalPath);
  const childRefs =
    loadedManifest.manifest.kind === "team"
      ? loadedManifest.manifest.members.map((member) => member.ref)
      : (loadedManifest.manifest.subagents ?? []).map((subagent) => subagent.ref);

  const nestedPaths = await Promise.all(
    childRefs.map((ref) =>
      collectManifestPaths(
        getManifestPath(path.resolve(getProjectRoot(canonicalPath), ref)),
        true,
        visited
      )
    )
  );

  return [canonicalPath, ...nestedPaths.flat()];
};

const manifestChanged = (current: ProjectManifest, next: ProjectManifest): boolean =>
  JSON.stringify(current) !== JSON.stringify(next);

const assertRuntimeMutationAllowed = (
  manifest: ProjectManifest,
  recursive: boolean
): manifest is AgentManifest => {
  if (manifest.kind === "agent") {
    return true;
  }

  if (recursive) {
    return false;
  }

  throw new SpawnfileError("validation_error", TEAM_RUNTIME_COMMAND_ERROR);
};

const validateAgentRuntimeMutation = (manifest: AgentManifest): void => {
  validateAgentSurfaceSupport(manifest);
  const runtimeName =
    typeof manifest.runtime === "string" ? manifest.runtime : manifest.runtime?.name;
  if (!runtimeName) {
    return;
  }

  assertRuntimeSupportsExecutionModelAuth(
    runtimeName,
    manifest.execution,
    manifest.name
  );
};

export const setProjectRuntime = async (
  options: ProjectRuntimeOptions
): Promise<UpdateProjectRuntimeResult> => {
  await assertRuntimeCanCompile(options.runtime);

  const recursive = options.recursive ?? false;
  const manifestPaths = await collectManifestPaths(
    resolveTargetManifestPath(options.path),
    recursive
  );
  const updatedFiles: string[] = [];

  for (const manifestPath of manifestPaths) {
    const loadedManifest = await loadManifest(manifestPath);
    const manifest = loadedManifest.manifest;

    if (!assertRuntimeMutationAllowed(manifest, recursive)) {
      continue;
    }

    const nextManifest: AgentManifest = {
      ...manifest,
      runtime: options.runtime
    };

    validateAgentRuntimeMutation(nextManifest);

    if (!manifestChanged(manifest, nextManifest)) {
      continue;
    }

    await writeUtf8File(manifestPath, renderSpawnfile(nextManifest));
    updatedFiles.push(manifestPath);
  }

  return { updatedFiles };
};
