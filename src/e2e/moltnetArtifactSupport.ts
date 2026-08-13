import type { DockerCommandRunner } from "./moltnetE2ESupport.js";

/** Counts non-blank JSONL lines, generic over any file that stores one JSON object per line (memory event logs,
 * causal event logs, ...). Split out of moltnetMemeticsArtifacts.ts so officeSim.ts can use it without depending
 * on the bespoke memetics-transcript module. */
export const countJsonlLines = (content: string): number =>
  content.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0).length;

export interface CopyContainerPathInput {
  containerName: string;
  containerPath: string;
  dockerCommand: string;
  hostPath: string;
  runCommand: DockerCommandRunner;
}

/** Best-effort `docker cp` from a running container; returns false instead of throwing on failure. */
export const copyContainerPathToHost = async (input: CopyContainerPathInput): Promise<boolean> => {
  try {
    await input.runCommand(input.dockerCommand, [
      "cp",
      `${input.containerName}:${input.containerPath}`,
      input.hostPath
    ]);
    return true;
  } catch {
    return false;
  }
};
