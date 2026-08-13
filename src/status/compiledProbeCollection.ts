import { readFile } from "node:fs/promises";

import type { LoadedCompileReport } from "./compileReport.js";
import { collectLifecycleProbeObservations } from "./lifecycleProbes.js";
import { collectMoltnetWiringProbeObservations } from "./moltnetWiringProbes.js";
import type { StatusObservation } from "./types.js";

/**
 * CLI-facing glue for the B38 offline lifecycle + Moltnet-wiring probes:
 * a real disk `readFile` for the static (`--out <dir>`) status path, a
 * stub that always resolves `null` for the home-deployment status path
 * (no compiled output tree exists there at all), and one function that
 * runs both probe collectors and concatenates their observations. Kept out
 * of `src/cli/statusCommand.ts` to stay under this repo's 400-line file
 * cap — this is CLI wiring plumbing, not a new probe contract.
 */
export type CompiledProbeReadFile = (filePath: string) => Promise<string | null>;

export interface CompiledProbeCollectors {
  collectLifecycleProbeObservations?: typeof collectLifecycleProbeObservations;
  collectMoltnetWiringProbeObservations?: typeof collectMoltnetWiringProbeObservations;
}

// Never throws: an unreadable path (missing file, permissions, not a
// regular file) resolves null so a probe reports its own defined
// unreadable-input severity instead of crashing status.
export const readCompiledProbeFile: CompiledProbeReadFile = async (filePath) => {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
};

// Home-deployment status has no on-disk compiled output tree (no `--out`
// directory, no container/rootfs mirror) to read from at all — every read
// resolves null so the probes report their own defined "nothing to check"
// unknown, never a crash and never a false ok.
export const unavailableCompiledProbeFile: CompiledProbeReadFile = async () => null;

export const collectCompiledProbeObservations = async (
  loadedReport: LoadedCompileReport,
  outputDirectory: string | null,
  readFileFn: CompiledProbeReadFile,
  collectors: CompiledProbeCollectors = {}
): Promise<StatusObservation[]> => {
  const collectLifecycle =
    collectors.collectLifecycleProbeObservations ?? collectLifecycleProbeObservations;
  const collectWiring =
    collectors.collectMoltnetWiringProbeObservations ?? collectMoltnetWiringProbeObservations;

  return [
    ...await collectLifecycle({ loadedReport, outputDirectory, readFile: readFileFn }),
    ...await collectWiring({ loadedReport, outputDirectory, readFile: readFileFn })
  ];
};
