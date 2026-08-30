import type { Command } from "commander";

import {
  createPreparedEvidenceHelperExecutor,
  prepareEvidenceExportHelper,
  type PreparedEvidenceHelperReceipt,
} from "../evidenceExportHelper/index.js";
import type { DockerArtifactExecutor } from "../target/dockerArtifactsProvider.js";
import { resolveSpawnfileHome } from "../auth/index.js";
import path from "node:path";

import { STANDARD_WORLD_BASE_IMAGE } from "./targetConfigResolver.js";
import type { CliStreams } from "./runCli.js";

interface CommandOptions {
  readonly baseImage: string;
  readonly context: string;
  readonly dockerCommand: string;
  readonly json: boolean;
  readonly timeoutMs: string;
}
export interface PrepareEvidenceExportHelperInput {
  readonly baseImage: string;
  readonly context: string;
  readonly dockerCommand: string;
  readonly timeoutMs: number;
}
export type PrepareEvidenceExportHelper = (input: PrepareEvidenceExportHelperInput) => Promise<PreparedEvidenceHelperReceipt>;

const timeout = (raw: string): number => {
  if (!/^[1-9][0-9]{0,5}$/u.test(raw)) throw new TypeError();
  const value = Number(raw);
  if (value > 120_000) throw new TypeError();
  return value;
};
export const createDefaultEvidenceExportHelperPreparer = (
  executorFor: (dockerCommand: string) => DockerArtifactExecutor = createPreparedEvidenceHelperExecutor,
): PrepareEvidenceExportHelper => async (input) => prepareEvidenceExportHelper({
  baseImage: input.baseImage,
  context: input.context,
  executor: executorFor(input.dockerCommand),
  privateRoot: path.join(resolveSpawnfileHome(), "target", "evidence-helper"),
  timeoutMs: input.timeoutMs,
});
const defaultPreparer = createDefaultEvidenceExportHelperPreparer();

export const registerEvidenceExportHelperCommand = (
  program: Command,
  streams: CliStreams,
  setExitCode: (value: 1 | 2) => void,
  preparer: PrepareEvidenceExportHelper = defaultPreparer,
): void => {
  const helper = program.command("helper")
    .description("Prepare package-owned local development helpers");
  helper.command("prepare-evidence-export")
    .description("Prepare Spawnfile-owned local evidence export helper")
    .requiredOption("--context <name>", "Explicit local Docker context")
    .option("--base-image <reference>", "Already-present Node base image", STANDARD_WORLD_BASE_IMAGE)
    .option("--docker-command <command>", "Docker-compatible command", "docker")
    .option("--timeout-ms <milliseconds>", "Bounded command timeout", "120000")
    .requiredOption("--json", "Emit the versioned opaque receipt JSON")
    .action(async (options: CommandOptions) => {
      let timeoutMs: number;
      try { timeoutMs = timeout(options.timeoutMs); }
      catch { streams.stderr("error: Invalid local evidence-export helper options"); setExitCode(2); return; }
      try {
        const receipt = await preparer({ baseImage: options.baseImage, context: options.context,
          dockerCommand: options.dockerCommand, timeoutMs });
        streams.stdout(JSON.stringify(receipt));
      } catch { streams.stderr("error: Prepared evidence-export helper failed"); setExitCode(1); }
    });
};
