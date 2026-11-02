import path from "node:path";

import { requireAuthProfile } from "../auth/index.js";
import { createBootedTrialRun } from "../compiler/training/trial/index.js";
import { bindBootedJudges, createDaimonBootedAdapter } from "../runtime/daimon/training/booted/index.js";
import { SpawnfileError } from "../shared/index.js";
import type { RunTrainingOptions } from "./trainingExecution.js";

const failure = (message: string): SpawnfileError => new SpawnfileError("runtime_error", message);
const flag = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
};

/**
 * Production-booted training for a Daimon subject: the training core and the
 * grader run here, and every trial is the subject's own compiled organization
 * in its own container, sharing the run's one auth gateway (and so one login).
 * Every subscription judgment of the run wakes one of the run's warm, tool-free
 * judge containers on that same gateway; none reads a personal login.
 */
export const runBootedTraining = async (options: RunTrainingOptions): Promise<number> => {
  if (!options.authProfile) throw failure("Production-booted Daimon training requires --auth-profile (the login its auth gateway holds)");
  const out = flag(options.args, "out");
  if (!out) throw failure("Production-booted Daimon training requires --out");
  const system = options.context.documents.find((document) => document.role === "system");
  const instructions = flag(options.args, "instructions") === undefined
    ? system ? ["--source-root", options.context.project.root, "--instructions", system.destinationPath]
      : (() => { throw failure(`Agent ${options.context.agent.id} declares no system document to train`); })()
    : [];
  const run = createBootedTrialRun({
    agentManifestPath: options.context.agent.source,
    authProfile: await requireAuthProfile(options.authProfile),
    scratchRoot: path.join(path.resolve(out), "booted-trials")
  });
  bindBootedJudges(run);
  try {
    const { main } = await import("../runtime/trainingCli.js");
    return await main(["train", ...options.args, ...(flag(options.args, "runtime") ? [] : ["--runtime", "daimon"]), ...instructions], {
      cwd: process.cwd(), signal: options.signal, stdout: options.streams.stdout, stderr: options.streams.stderr
    }, { adapter: (_runtime, adapter) => createDaimonBootedAdapter({ launcher: run, timeoutMs: adapter.timeoutMs }) });
  } finally {
    bindBootedJudges(undefined);
    await run.close();
  }
};
