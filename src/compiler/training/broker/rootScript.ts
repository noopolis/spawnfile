import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

/**
 * Linux `MAX_ARG_STRLEN`: the most bytes one `execve` argument may carry. A
 * generated root program passed as `bash -c <script>` dies with `E2BIG` past
 * it — and a slot program embeds its declared skills, so the size grows with
 * the declaration. macOS has no per-argument limit, which is why this is
 * asserted in tests rather than observed.
 */
export const LINUX_MAX_ARG_STRLEN = 131_072;

export type TrainingRootScriptRunner = (file: string, args: readonly string[], options: { maxBuffer: number }) => Promise<{ stdout: string; stderr: string }>;
const execFileAsync = promisify(execFile) as unknown as TrainingRootScriptRunner;

export interface TrainingRootScriptOptions { shell?: string; maxBuffer?: number; run?: TrainingRootScriptRunner; tmpRoot?: string }

/** The argv a generated script runs under: bounded and independent of the script's size. */
export const trainingRootScriptArgv = (scriptFile: string): string[] => ["--noprofile", "--norc", "-eu", scriptFile];

/**
 * Runs a generated root shell program from a fresh `0700` directory holding a
 * `0600` script file, never from argv and never from stdin (a child that reads
 * stdin would consume the rest of the program). The directory is removed
 * afterwards, whatever the outcome.
 */
export const runTrainingRootScript = async (script: string, options: TrainingRootScriptOptions = {}): Promise<{ stdout: string; stderr: string }> => {
  const directory = await mkdtemp(path.join(options.tmpRoot ?? os.tmpdir(), "spawnfile-root-script-"));
  try {
    const file = path.join(directory, "script.sh");
    await writeFile(file, script, { mode: 0o600, flag: "wx" });
    return await (options.run ?? execFileAsync)(options.shell ?? "/bin/bash", trainingRootScriptArgv(file), { maxBuffer: options.maxBuffer ?? 1024 * 1024 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
