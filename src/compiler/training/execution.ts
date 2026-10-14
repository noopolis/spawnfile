import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { SpawnfileError } from "../../shared/index.js";
import { trainingPlanSchema, trainingPlanOptimizerSchema, type TrainingPlan } from "./plan/contract.js";
import type { LoadedTrainingProject } from "./plan/types.js";
import { trainingPreparationSchema } from "./preparation/contract.js";
import { readBoundedJson } from "./preparation/inputs.js";
import { trainingContainerConfigSchema, trainingImageSchema } from "./container/contract.js";

export const TRAINING_EXECUTION_FILE = "/run/paideia/execution.json";
export { TRAINING_EXECUTION_CAPABILITY_LABEL, TRAINING_EXECUTION_VERSION } from "./contract.js";
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
  trainingConfig?: string;
  trainingImage?: string;
}

/** Resolve local declaration and authoring defaults; no writes, auth reads or execution. */
export const lowerTrainingExecution = async (options: LowerTrainingExecutionOptions) => {
  const { project, plan } = options;
  if (!plan.targets.length || !plan.optimizer) return invalid(`Agent ${plan.agent.id} has no executable training targets`);
  const agent = project.compilePlan.nodes.find(node => node.id === plan.agent.id)!;
  const agentDirectory = path.dirname(agent.value.kind === "agent" ? agent.value.sourcePath ?? agent.value.source : agent.value.source);
  const candidates = [...new Set([agentDirectory, project.root].map(root => path.join(root, "training/container.json")))];
  let trainingConfig = options.trainingConfig === undefined ? undefined : path.resolve(options.trainingConfig);
  if (trainingConfig === undefined) for (const file of candidates) if (await exists(file)) { trainingConfig = file; break; }
  if (trainingConfig === undefined) return invalid(`Training requires a container declaration at ${candidates.join(" or ")}, or --training-config`);
  trainingConfig = await realpath(trainingConfig);
  const raw = await readBoundedJson(trainingConfig) as { version?: unknown; image?: unknown };
  const preparation = raw.version === "spawnfile.training-container.v2" ||
    (["spawnfile.training-container.v3", "spawnfile.training-container.v4"].includes(String(raw.version)) && raw.image !== undefined);
  const declaration = preparation ? trainingPreparationSchema.parse(raw) : trainingContainerConfigSchema.parse(raw);
  const trainingImage = options.trainingImage === undefined ? undefined : trainingImageSchema.parse(options.trainingImage);
  if (!preparation && trainingImage === undefined) {
    return invalid("A lowered container launch configuration requires --training-image; use a v2/v4 preparation declaration for a declared image");
  }
  const args = [...options.args];
  // The CLI has one dataset per role. Refuse incompatible target datasets rather than choosing silently.
  for (const role of ["train", "test"] as const) {
    if (option(args, `--${role}`) !== undefined) continue;
    const sources = [...new Set(plan.targets.map(target => target.datasets[role].sourcePath))];
    if (sources.length !== 1) return invalid(`Training targets have different ${role} datasets; use --${role} to select an execution dataset`);
    args.push(`--${role}`, sources[0]!);
  }
  if (!args.includes("--editable")) for (const file of [...new Set(plan.targets.flatMap(target => target.files.map(file => file.path)))]) {
    args.push("--editable", file);
  }
  if (!args.includes("--optimizer-model")) args.push("--optimizer-model", plan.optimizer.model);
  if (args.includes("--resume") && option(args, "--out") === undefined) return invalid("--resume requires --out identifying the exact prior experiment");
  const output = path.resolve(option(args, "--out") ?? path.join(project.root, ".spawn/training",
    encodeURIComponent(plan.agent.id), `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`));
  if (!args.includes("--out")) args.push("--out", output);
  else args[args.indexOf("--out") + 1] = output;
  const datasetPins = [...new Set(plan.targets.flatMap(target => Object.values(target.datasets)
    .filter(dataset => dataset !== null).map(dataset => dataset.sourcePath)))].map(sourcePath => {
    const loaded = project.datasets[sourcePath];
    if (!loaded) return invalid(`Authored dataset was not captured during plan loading: ${sourcePath}`);
    return { sourcePath, sha256: loaded.sha256 };
  });
  const execution = trainingExecutionSchema.parse({ version: "spawnfile.training-execution.v1", authoring: plan, datasetPins,
    optimizer: { ...plan.optimizer, model: option(args, "--optimizer-model")! }, args, output });
  return { execution, trainingConfig, trainingImage, declaration };
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

/** Preserve identities and all dataset roles while projecting only filesystem addresses. */
export const mapTrainingExecution = (execution: TrainingExecution, map: (file: string) => string): TrainingExecution => {
  const source = <T extends { sourcePath: string }>(value: T): T => ({ ...value, sourcePath: map(value.sourcePath) });
  const args = [...execution.args];
  for (let index = 0; index < args.length; index++) {
    if (["--train", "--test", "--out", "--cost-config"].includes(args[index]!)) args[++index] = map(args[index]!);
    else if (args[index] === "--resource") {
      const value = args[++index]!, split = value.indexOf("=");
      args[index] = `${value.slice(0, split)}=${map(value.slice(split + 1))}`;
    }
  }
  return trainingExecutionSchema.parse({ ...execution, datasetPins: execution.datasetPins.map(source), args, output: map(execution.output), authoring: {
    ...execution.authoring,
    project: { root: map(execution.authoring.project.root), manifest: map(execution.authoring.project.manifest) },
    graders: execution.authoring.graders.map(source),
    targets: execution.authoring.targets.map(target => ({ ...target, files: target.files.map(source), datasets: {
      train: source(target.datasets.train), test: source(target.datasets.test),
      validation: target.datasets.validation === null ? null : source(target.datasets.validation)
    } }))
  } });
};

/** Resume changes position/presence of --resume, not the experiment's effective inputs. */
export const trainingExecutionIdentity = (execution: TrainingExecution): unknown => {
  const flags: string[][] = [];
  for (let index = 0; index < execution.args.length; index++) {
    const flag = execution.args[index]!;
    if (flag === "--resume") continue;
    flags.push(flag === "--dry-run" ? [flag] : [flag, execution.args[++index]!]);
  }
  return { ...execution, args: flags.sort(([left], [right]) => left! < right! ? -1 : left! > right! ? 1 : 0) };
};
