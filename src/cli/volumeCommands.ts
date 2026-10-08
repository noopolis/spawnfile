import { Command, InvalidArgumentError } from "commander";

import {
  feedResultClean, refreshVolumeFeed, resolveFeedTarget, verifyVolumeFeed, type FeedRefreshResult, type FeedTargetOptions
} from "../volume/index.js";
import type { CliStreams } from "./runCli.js";

interface VolumeCommandOptions { healLimit?: number; fetch?: boolean; json?: boolean; stateDir?: string; volumePath?: string }

const positiveInteger = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new InvalidArgumentError("must be a positive integer");
  return parsed;
};

const targetOptions = (options: VolumeCommandOptions): FeedTargetOptions => ({
  ...(options.fetch === false ? { fetch: false } : {}),
  ...(options.healLimit ? { healLimit: options.healLimit } : {}),
  ...(options.stateDir ? { stateDir: options.stateDir } : {}),
  ...(options.volumePath ? { volumePath: options.volumePath } : {})
});

const report = (streams: CliStreams, result: FeedRefreshResult, json: boolean | undefined): void => {
  if (json) { streams.stdout(JSON.stringify(result)); return; }
  streams.stdout(`${result.status}${result.revision ? ` ${result.revision}` : ""}`);
  for (const finding of result.findings) streams.stderr(`finding: ${finding}`);
};

const withShared = (command: Command): Command => command
  .argument("<id>", "Volume resource id that declares feed")
  .argument("[path]", "Project directory or Spawnfile path", process.cwd())
  .option("--volume-path <dir>", "Host directory of the volume content (default: docker volume inspect)")
  .option("--state-dir <dir>", "Host state directory, outside the volume and on its filesystem")
  .option("--json", "Print the result as one JSON line");

/**
 * `spawnfile volume refresh|verify`: host-side operations on a fed volume, suitable for a timer.
 * Exit 0 when the volume is clean (current, freshly landed, or another writer holds the lock); exit 1
 * when anything needs a human (tampering found, repaired or not, or a refusal).
 */
export const registerVolumeCommands = (program: Command, streams: CliStreams, setExitCode: (code: number) => void): void => {
  const volume = program.command("volume").description("Operate host-fed volumes");
  withShared(volume.command("refresh").description("Land the feed's current content by atomic swap, or verify and heal what is landed"))
    .option("--no-fetch", "Do not fetch a git feed before resolving its ref")
    .option("--heal-limit <n>", "Re-lands of one revision before auto-repair is suspended", positiveInteger)
    .action(async (id: string, inputPath: string, options: VolumeCommandOptions) => {
      const target = await resolveFeedTarget(inputPath, id, targetOptions(options));
      const result = refreshVolumeFeed(target, { log: (line) => streams.stderr(line) });
      report(streams, result, options.json);
      setExitCode(feedResultClean(result) ? 0 : 1);
    });
  withShared(volume.command("verify").description("Check a fed volume against the host record without changing it"))
    .action(async (id: string, inputPath: string, options: VolumeCommandOptions) => {
      const target = await resolveFeedTarget(inputPath, id, targetOptions(options));
      const result = verifyVolumeFeed(target, { log: (line) => streams.stderr(line) });
      report(streams, result, options.json);
      setExitCode(feedResultClean(result) ? 0 : 1);
    });
};
