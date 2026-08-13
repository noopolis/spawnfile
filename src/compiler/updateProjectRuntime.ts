import path from "node:path";

import {
  getManifestPath,
  writeUtf8File
} from "../filesystem/index.js";
import type { AgentManifest, InlineAgentMember, TeamManifest } from "../manifest/index.js";
import {
  loadManifest,
  materializeInlineAgentManifest,
  renderSpawnfile
} from "../manifest/index.js";
import { assertRuntimeCanCompile } from "../runtime/index.js";
import { SpawnfileError } from "../shared/index.js";

import { assertRuntimeSupportsExecutionModelAuth } from "./modelAuth.js";
import {
  collectProjectManifestPaths,
  rewriteInlineAgentMembers
} from "./projectManifestGraph.js";
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

const manifestChanged = (current: ProjectManifest, next: ProjectManifest): boolean =>
  JSON.stringify(current) !== JSON.stringify(next);

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

const setInlineRuntime = (
  team: TeamManifest,
  member: InlineAgentMember,
  runtime: string
): InlineAgentMember => {
  const nextMember = { ...member, runtime };
  validateAgentRuntimeMutation(materializeInlineAgentManifest(team, nextMember));
  return nextMember;
};

export const setProjectRuntime = async (
  options: ProjectRuntimeOptions
): Promise<UpdateProjectRuntimeResult> => {
  await assertRuntimeCanCompile(options.runtime);

  const recursive = options.recursive ?? false;
  const manifestPaths = await collectProjectManifestPaths(
    resolveTargetManifestPath(options.path),
    recursive
  );
  const updatedFiles: string[] = [];

  for (const manifestPath of manifestPaths) {
    const loadedManifest = await loadManifest(manifestPath);
    const manifest = loadedManifest.manifest;

    let nextManifest: ProjectManifest;
    if (manifest.kind === "agent") {
      nextManifest = {
        ...manifest,
        runtime: options.runtime
      };
      validateAgentRuntimeMutation(nextManifest);
    } else {
      if (!recursive) {
        throw new SpawnfileError("validation_error", TEAM_RUNTIME_COMMAND_ERROR);
      }
      nextManifest = rewriteInlineAgentMembers(manifest, (member) =>
        setInlineRuntime(manifest, member, options.runtime)
      );
    }

    if (!manifestChanged(manifest, nextManifest)) {
      continue;
    }

    await writeUtf8File(manifestPath, renderSpawnfile(nextManifest));
    updatedFiles.push(manifestPath);
  }

  return { updatedFiles };
};
