import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { defaultTrainingOutputRoot } from "./output.js";
import { SpawnfileError } from "../../shared/index.js";
import { trainingPlanSchema, trainingPlanOptimizerSchema, type TrainingPlan } from "./plan/contract.js";
import type { LoadedTrainingProject } from "./plan/types.js";

export const trainingExecutionSchema = z.object({
  version: z.literal("spawnfile.training-execution.v1"),
  authoring: trainingPlanSchema,
  datasetPins: z.array(z.object({ sourcePath: z.string().min(1), sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u) }).strict()),
  optimizer: trainingPlanOptimizerSchema,
  args: z.array(z.string().min(1)),
  output: z.string().min(1)
}).strict();
export type TrainingExecution = z.infer<typeof trainingExecutionSchema>;

const invalid = (message: string): never => { throw new SpawnfileError("validation_error", message); };
const option = (args: readonly string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};
const exists = async (file: string): Promise<boolean> => {
  try { await lstat(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
};

export interface LowerTrainingExecutionOptions {
  project: LoadedTrainingProject;
  plan: TrainingPlan;
  args: readonly string[];
}

/** Resolve authoring defaults into training CLI arguments; no writes, auth reads or execution. */
export const lowerTrainingExecution = async (options: LowerTrainingExecutionOptions) => {
  const { project, plan } = options;
  if (!plan.targets.length || !plan.optimizer) return invalid(`Agent ${plan.agent.id} has no executable training targets`);
  const args = [...options.args];
  if (!args.includes("--experiment-timeout-ms") && !args.includes("--timeout-ms")) {
    args.push("--experiment-timeout-ms", String(plan.deadlines?.experiment_ms ?? 43_200_000));
  }
  if (!args.includes("--trial-timeout-ms") && plan.deadlines?.trial_ms !== undefined) {
    args.push("--trial-timeout-ms", String(plan.deadlines.trial_ms));
  }
  // These are authoring locators. The receipt consumer lowers ALL target datasets into one file per role.
  for (const role of ["train", "validation", "test"] as const) {
    if (option(args, `--${role}`) !== undefined) continue;
    const sources = [...new Set(plan.targets.flatMap(target => target.datasets[role] ? [target.datasets[role].sourcePath] : []))];
    if (role === "validation" && sources.length === 0) continue;
    args.push(`--${role}`, sources[0]!);
  }
  if (!args.includes("--editable")) for (const file of [...new Set(plan.targets.flatMap(target => target.files.map(file => file.path)))]) {
    args.push("--editable", file);
  }
  if (!args.includes("--optimizer-model")) args.push("--optimizer-model", plan.optimizer.model);
  if (args.includes("--resume") && option(args, "--out") === undefined) return invalid("--resume requires --out identifying the exact prior experiment");
  const datasetPins = [...new Set(plan.targets.flatMap(target => Object.values(target.datasets)
    .filter(dataset => dataset !== null).map(dataset => dataset.sourcePath)))].map(sourcePath => {
    const loaded = project.datasets[sourcePath];
    if (!loaded) return invalid(`Authored dataset was not captured during plan loading: ${sourcePath}`);
    return { sourcePath, sha256: loaded.sha256 };
  });
  const output = path.resolve(option(args, "--out") ?? path.join(defaultTrainingOutputRoot(project.root, datasetPins.map(pin => pin.sourcePath)),
    encodeURIComponent(plan.agent.id), `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`));
  if (!args.includes("--out")) args.push("--out", output);
  else args[args.indexOf("--out") + 1] = output;
  const execution = trainingExecutionSchema.parse({ version: "spawnfile.training-execution.v1", authoring: plan, datasetPins,
    optimizer: { ...plan.optimizer, model: option(args, "--optimizer-model")! }, args, output });
  return { execution };
};

/** Allocation is separate so dry-run never creates a directory, and aliases fail before writes. */
export const allocateTrainingOutputParent = async (output: string): Promise<void> => {
  const parent = path.dirname(path.resolve(output));
  const missing: string[] = [];
  let ancestor = parent;
  while (!await exists(ancestor)) { missing.unshift(ancestor); ancestor = path.dirname(ancestor); }
  if (await realpath(ancestor) !== ancestor || !(await lstat(ancestor)).isDirectory()) invalid("Training output parent must be a canonical directory");
  for (const directory of missing) {
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) invalid("Training output parent must be a canonical directory");
  }
};
