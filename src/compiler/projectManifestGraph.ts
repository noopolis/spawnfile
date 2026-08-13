import path from "node:path";

import {
  getCanonicalManifestPath,
  getManifestPath,
  getProjectRoot
} from "../filesystem/index.js";
import {
  isReferencedMember,
  loadManifest,
  type InlineAgentMember,
  type TeamManifest
} from "../manifest/index.js";

export const createInlineAgentSource = (teamSource: string, memberId: string): string =>
  `${teamSource}#member=${encodeURIComponent(memberId)}`;

export const collectProjectManifestPaths = async (
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
  const childRefs = loadedManifest.manifest.kind === "team"
    ? loadedManifest.manifest.members.filter(isReferencedMember).map((member) => member.ref)
    : (loadedManifest.manifest.subagents ?? []).map((subagent) => subagent.ref);
  const nestedPaths = await Promise.all(
    childRefs.map((ref) =>
      collectProjectManifestPaths(
        getManifestPath(path.resolve(getProjectRoot(canonicalPath), ref)),
        true,
        visited
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
