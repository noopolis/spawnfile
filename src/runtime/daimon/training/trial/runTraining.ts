import { TRAINING_MOMENT_PROFILE } from "../../../../compiler/training/index.js";
import { momentPreparation } from "../../../../compiler/training/trial/index.js";
import { SpawnfileError } from "../../../../shared/index.js";
import { invokeTrainingCore, type RuntimeTrainingRunOptions } from "../../../index.js";
import { createDaimonBootedAdapter } from "../booted/index.js";
import { openTrainingRun } from "./run.js";

const failure = (message: string): SpawnfileError => new SpawnfileError("runtime_error", message);
const flag = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
};

export const runDaimonTraining = async (options: RuntimeTrainingRunOptions): Promise<number> => {
  if (!options.authProfile) throw failure("Production-booted Daimon training requires --auth-profile (the login its auth gateway holds)");
  const runtime = options.context.agent.runtime;
  const requestedRuntime = flag(options.args, "runtime");
  if (requestedRuntime && requestedRuntime !== runtime) {
    throw new SpawnfileError("validation_error", `Training runtime ${requestedRuntime} differs from the selected runtime ${runtime}`);
  }
  const out = flag(options.args, "out");
  if (!out) throw failure("Production-booted Daimon training requires --out");
  const system = options.context.documents.find((document) => document.role === "system");
  const instructions = flag(options.args, "instructions") === undefined
    ? system ? ["--source-root", options.context.project.root, "--instructions", system.destinationPath]
      : (() => { throw failure(`Agent ${options.context.agent.id} declares no system document to train`); })()
    : [];
  const { run, close } = await openTrainingRun({ ...options.controls, authProfile: options.authProfile, out, scratch: "booted-trials",
    agentManifestPath: options.context.agent.source, projectManifestPath: options.context.project.manifest,
    streams: options.streams, ...(options.signal ? { signal: options.signal } : {}) });
  try {
    // The subject's own model labels its trials; an engine that pins no model is labelled by the engine.
    const agent = options.context.agent;
    const model = flag(options.args, "model") === undefined ? ["--model", agent.model?.name ?? agent.engine ?? agent.runtime] : [];
    return await invokeTrainingCore(["train", ...options.args, ...(requestedRuntime ? [] : ["--runtime", runtime]), ...model, ...instructions], {
      cwd: process.cwd(), signal: options.signal, stdout: options.streams.stdout, stderr: options.streams.stderr
    }, { adapter: (_runtime, adapter) => createDaimonBootedAdapter({ launcher: run, timeoutMs: adapter.timeoutMs }),
      preparations: { [TRAINING_MOMENT_PROFILE]: momentPreparation }, unlockedSetupPaths: ["moment"],
      // The trial container boots its record's moment itself; the host prepares nothing for it.
      prepareEnvironment: async () => ({}) });
  } finally {
    await close();
  }
};
