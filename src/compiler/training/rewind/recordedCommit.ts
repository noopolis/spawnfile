import { recordedCommitSchema } from "./contract.js";
import { rewindGit } from "./gitProcess.js";

/** Recorded identity names the commit object itself, never a selector or a peeled tag. */
export const resolveRecordedCommit = async (repository: string, value: string): Promise<string> => {
  const commit = recordedCommitSchema.parse(value);
  const type = (await rewindGit(repository, ["cat-file", "-t", commit])).toString().trim();
  if (type !== "commit") throw new Error(`Recorded object ${commit} must be a commit object; found ${type}`);
  return commit;
};
