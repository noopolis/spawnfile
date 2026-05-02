import path from "node:path";

import {
  getCanonicalManifestPath,
  getManifestPath,
  getProjectRoot,
  writeUtf8File
} from "../filesystem/index.js";
import type { AgentManifest, TeamManifest } from "../manifest/index.js";
import { loadManifest, renderSpawnfile } from "../manifest/index.js";

import {
  type AddProjectSurfaceOptions,
  type ProjectSurfaceSummariesResult,
  type RemoveProjectSurfaceOptions,
  type ShowProjectSurfacesOptions,
  type UpdateProjectSurfacesResult,
  assertSurfaceMutationAllowed,
  removeSurface,
  updateSurfaceAccess,
  upsertSurface,
  validateAgentSurfaceSupport
} from "./surfaceDefinitions.js";
import type { ProjectSurfaceAccessOptions } from "./surfaceDefinitions.js";

type ProjectManifest = AgentManifest | TeamManifest;

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

const rewriteTouchedManifests = async (
  manifestPaths: string[],
  mutate: (manifest: ProjectManifest, manifestPath: string) => ProjectManifest | null
): Promise<UpdateProjectSurfacesResult> => {
  const rewrites: Array<{ manifest: ProjectManifest; manifestPath: string }> = [];

  for (const manifestPath of manifestPaths) {
    const loadedManifest = await loadManifest(manifestPath);
    const nextManifest = mutate(loadedManifest.manifest, manifestPath);
    if (!nextManifest || !manifestChanged(loadedManifest.manifest, nextManifest)) {
      continue;
    }

    if (nextManifest.kind === "agent") {
      validateAgentSurfaceSupport(nextManifest);
    }

    rewrites.push({
      manifest: nextManifest,
      manifestPath
    });
  }

  for (const rewrite of rewrites) {
    await writeUtf8File(rewrite.manifestPath, renderSpawnfile(rewrite.manifest));
  }

  return {
    updatedFiles: rewrites.map((rewrite) => rewrite.manifestPath)
  };
};

export {
  type AddProjectSurfaceOptions,
  type ProjectSurfaceAccessOptions,
  type ProjectSurfaceSummariesResult,
  type RemoveProjectSurfaceOptions,
  type ShowProjectSurfacesOptions,
  type UpdateProjectSurfacesResult,
  resolvePortableSurfaceName
} from "./surfaceDefinitions.js";
export type { ProjectSurfaceSummary, SurfaceAccessMode, SurfaceName } from "./surfaceDefinitions.js";

export const addProjectSurface = async (
  options: AddProjectSurfaceOptions
): Promise<UpdateProjectSurfacesResult> => {
  const recursive = options.recursive ?? false;
  const manifestPaths = await collectManifestPaths(
    resolveTargetManifestPath(options.path),
    recursive
  );

  return rewriteTouchedManifests(manifestPaths, (manifest) => {
    if (!assertSurfaceMutationAllowed(manifest, recursive)) {
      return null;
    }

    return {
      ...manifest,
      surfaces: upsertSurface(manifest.surfaces, options)
    };
  });
};

export const setProjectSurfaceAccess = async (
  options: ProjectSurfaceAccessOptions
): Promise<UpdateProjectSurfacesResult> => {
  const recursive = options.recursive ?? false;
  const manifestPaths = await collectManifestPaths(
    resolveTargetManifestPath(options.path),
    recursive
  );

  return rewriteTouchedManifests(manifestPaths, (manifest, manifestPath) => {
    if (!assertSurfaceMutationAllowed(manifest, recursive)) {
      return null;
    }

    const nextSurfaces = updateSurfaceAccess(
      manifest.surfaces,
      options,
      manifestPath,
      recursive
    );
    if (!nextSurfaces) {
      return null;
    }

    return {
      ...manifest,
      surfaces: nextSurfaces
    };
  });
};

export const removeProjectSurface = async (
  options: RemoveProjectSurfaceOptions
): Promise<UpdateProjectSurfacesResult> => {
  const recursive = options.recursive ?? false;
  const manifestPaths = await collectManifestPaths(
    resolveTargetManifestPath(options.path),
    recursive
  );

  return rewriteTouchedManifests(manifestPaths, (manifest) => {
    if (!assertSurfaceMutationAllowed(manifest, recursive)) {
      return null;
    }

    return {
      ...manifest,
      surfaces: removeSurface(manifest.surfaces, options.surface)
    };
  });
};

export const showProjectSurfaces = async (
  options: ShowProjectSurfacesOptions = {}
): Promise<ProjectSurfaceSummariesResult> => {
  const manifestPaths = await collectManifestPaths(
    resolveTargetManifestPath(options.path),
    options.recursive ?? false
  );
  const entries = [];

  for (const manifestPath of manifestPaths) {
    const loadedManifest = await loadManifest(manifestPath);
    if (options.recursive && loadedManifest.manifest.kind !== "agent") {
      continue;
    }

    entries.push({
      kind: loadedManifest.manifest.kind,
      manifestPath,
      name: loadedManifest.manifest.name,
      surfaces: loadedManifest.manifest.surfaces
    });
  }

  return { entries };
};
