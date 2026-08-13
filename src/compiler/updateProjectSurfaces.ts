import path from "node:path";

import {
  getManifestPath,
  writeUtf8File
} from "../filesystem/index.js";
import type { AgentManifest, InlineAgentMember, TeamManifest } from "../manifest/index.js";
import {
  isReferencedMember,
  loadManifest,
  materializeInlineAgentManifest,
  renderSpawnfile
} from "../manifest/index.js";

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
import {
  collectProjectManifestPaths,
  createInlineAgentSource,
  rewriteInlineAgentMembers
} from "./projectManifestGraph.js";

type ProjectManifest = AgentManifest | TeamManifest;
type AgentSurfaceDeclaration = AgentManifest | InlineAgentMember;

const resolveTargetManifestPath = (inputPath?: string): string =>
  getManifestPath(path.resolve(inputPath ?? process.cwd()));

const manifestChanged = (current: ProjectManifest, next: ProjectManifest): boolean =>
  JSON.stringify(current) !== JSON.stringify(next);

const mutateAgentDeclarations = (
  manifest: ProjectManifest,
  manifestPath: string,
  recursive: boolean,
  mutate: (
    declaration: AgentSurfaceDeclaration,
    source: string
  ) => AgentSurfaceDeclaration | null
): ProjectManifest | null => {
  if (manifest.kind === "agent") {
    return mutate(manifest, manifestPath) as AgentManifest | null;
  }

  if (!recursive) {
    assertSurfaceMutationAllowed(manifest, recursive);
    return null;
  }

  return rewriteInlineAgentMembers(manifest, (member) =>
    (mutate(
      member,
      createInlineAgentSource(manifestPath, member.id)
    ) as InlineAgentMember | null) ?? member
  );
};

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
    } else {
      for (const member of nextManifest.members) {
        if (!isReferencedMember(member)) {
          validateAgentSurfaceSupport(materializeInlineAgentManifest(nextManifest, member));
        }
      }
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
  const manifestPaths = await collectProjectManifestPaths(
    resolveTargetManifestPath(options.path),
    recursive
  );

  return rewriteTouchedManifests(manifestPaths, (manifest, manifestPath) => {
    return mutateAgentDeclarations(manifest, manifestPath, recursive, (declaration) => ({
      ...declaration,
      surfaces: upsertSurface(declaration.surfaces, options)
    }));
  });
};

export const setProjectSurfaceAccess = async (
  options: ProjectSurfaceAccessOptions
): Promise<UpdateProjectSurfacesResult> => {
  const recursive = options.recursive ?? false;
  const manifestPaths = await collectProjectManifestPaths(
    resolveTargetManifestPath(options.path),
    recursive
  );

  return rewriteTouchedManifests(manifestPaths, (manifest, manifestPath) => {
    return mutateAgentDeclarations(manifest, manifestPath, recursive, (declaration, source) => {
      const nextSurfaces = updateSurfaceAccess(
        declaration.surfaces,
        options,
        source,
        recursive
      );
      if (!nextSurfaces) {
        return null;
      }

      return {
        ...declaration,
        surfaces: nextSurfaces
      };
    });
  });
};

export const removeProjectSurface = async (
  options: RemoveProjectSurfaceOptions
): Promise<UpdateProjectSurfacesResult> => {
  const recursive = options.recursive ?? false;
  const manifestPaths = await collectProjectManifestPaths(
    resolveTargetManifestPath(options.path),
    recursive
  );

  return rewriteTouchedManifests(manifestPaths, (manifest, manifestPath) => {
    return mutateAgentDeclarations(manifest, manifestPath, recursive, (declaration) => ({
      ...declaration,
      surfaces: removeSurface(declaration.surfaces, options.surface)
    }));
  });
};

export const showProjectSurfaces = async (
  options: ShowProjectSurfacesOptions = {}
): Promise<ProjectSurfaceSummariesResult> => {
  const manifestPaths = await collectProjectManifestPaths(
    resolveTargetManifestPath(options.path),
    options.recursive ?? false
  );
  const entries = [];

  for (const manifestPath of manifestPaths) {
    const loadedManifest = await loadManifest(manifestPath);
    if (options.recursive && loadedManifest.manifest.kind === "team") {
      for (const member of loadedManifest.manifest.members) {
        if (isReferencedMember(member)) {
          continue;
        }
        entries.push({
          kind: "agent" as const,
          manifestPath: createInlineAgentSource(manifestPath, member.id),
          name: member.id,
          surfaces: member.surfaces
        });
      }
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
