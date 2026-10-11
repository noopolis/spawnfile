import { exportGitTree, safeCommittedPath } from "./gitTree.js";

/** Retain raw blob bytes: archive attributes may disclose refs added after the moment. */
export const exportFeedGitTree = async (repository: string, commit: string, destination: string, paths?: string[]): Promise<void> => {
  for (const selected of paths ?? []) safeCommittedPath(selected);
  await exportGitTree(repository, commit, destination, { paths });
};
