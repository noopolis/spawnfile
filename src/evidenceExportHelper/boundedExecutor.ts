import {
  DockerArtifactProviderError,
  type DockerArtifactExecutor,
} from "../target/dockerArtifactsProvider.js";
import {
  createBoundedDockerTargetExecFile,
  DockerTargetCommandFailure,
} from "../target/dockerTargetExecFile.js";

const missingExactImage = (args: readonly string[], error: unknown): boolean => {
  if (!(error instanceof DockerTargetCommandFailure)) return false;
  const command = args[0] === "--context" ? args.slice(2) : args;
  if (command.length !== 5 || command[0] !== "image" || command[1] !== "inspect"
    || command[3] !== "--format") return false;
  const match = /^(?:Error response from daemon: )?No such image: ([A-Za-z0-9_.:@/-]+)$/u
    .exec(error.stderr.trim());
  return match?.[1] === command[2];
};

/** Tree-safe private Docker executor used at every local-helper boundary. */
export const createPreparedEvidenceHelperExecutor = (
  dockerCommand: string,
): DockerArtifactExecutor => {
  const execute = createBoundedDockerTargetExecFile();
  return async (file, args, options) => {
    if (file !== "docker") throw new Error("Prepared evidence-export helper failed");
    try {
      return await execute(dockerCommand, args, {
        signal: options.signal,
        stdin: (options as { readonly stdin?: Uint8Array }).stdin,
        timeout: options.timeout,
      });
    } catch (error) {
      if (missingExactImage(args, error)) throw new DockerArtifactProviderError("image_not_found");
      throw error;
    }
  };
};
