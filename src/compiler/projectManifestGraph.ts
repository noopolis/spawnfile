import path from "node:path";

import {
  getCanonicalManifestPath,
  getManifestPath,
  getProjectRoot
} from "../filesystem/index.js";
import {
  isReferencedMember,
  loadManifest,
  NESTED_ADAPTERS_MESSAGE,
  type InlineAgentMember,
  type LoadedManifest,
  type TeamManifest
} from "../manifest/index.js";
import { SpawnfileError } from "../shared/index.js";

/** Only the invoked root may select adapter modules; nested declarations are refused, never ignored. */
export const assertRootOnlyAdapters = (loaded: LoadedManifest, rootManifestPath: string): LoadedManifest => {
  if (loaded.manifest.adapters !== undefined && getCanonicalManifestPath(loaded.manifestPath) !== rootManifestPath) {
    throw new SpawnfileError("invalid_manifest", `Invalid Spawnfile manifest ${loaded.manifestPath}: ${NESTED_ADAPTERS_MESSAGE} (${rootManifestPath})`);
  }
  return loaded;
};

export const createInlineAgentSource = (teamSource: string, memberId: string): string =>
  `${teamSource}#member=${encodeURIComponent(memberId)}`;

export const collectProjectManifestPaths = async (
  manifestPath: string,
  recursive: boolean,
  visited = new Set<string>(),
  rootManifestPath = getCanonicalManifestPath(manifestPath)
): Promise<string[]> => {
  const canonicalPath = getCanonicalManifestPath(manifestPath);
  if (visited.has(canonicalPath)) {
    return [];
  }

  visited.add(canonicalPath);
  if (!recursive) {
    return [canonicalPath];
  }

  const loadedManifest = assertRootOnlyAdapters(await loadManifest(canonicalPath), rootManifestPath);
  const childRefs = loadedManifest.manifest.kind === "team"
    ? loadedManifest.manifest.members.filter(isReferencedMember).map((member) => member.ref)
    : (loadedManifest.manifest.subagents ?? []).map((subagent) => subagent.ref);
  const nestedPaths = await Promise.all(
    childRefs.map((ref) =>
      collectProjectManifestPaths(
        getManifestPath(path.resolve(getProjectRoot(canonicalPath), ref)),
        true,
        visited,
        rootManifestPath
      )
    )
  );

  return [canonicalPath, ...nestedPaths.flat()];
};

export const rewriteInlineAgentMembers = (
  manifest: TeamManifest,
  mutate: (member: InlineAgentMember) => InlineAgentMember
): TeamManifest => ({
  ...manifest,
  members: manifest.members.map((member) =>
    isReferencedMember(member) ? member : mutate(member)
  )
});
