import { mkdir, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { trainingContextSchema, type TrainingContext } from "../contract.js";
import { createTrainingContext } from "../context.js";
import { trainingExecutionIdentity, trainingExecutionSchema } from "../execution.js";
import { lowerTrainingMoments, materializeTrainingCase, type LowerTrainingMomentsOptions } from "../moments.js";
import { loadTrainingProject, resolveTrainingPlan } from "../plan/index.js";
import { exactPath, sealTree, within } from "../preparation/files.js";
import { compileTrainingCandidate, type CompileTrainingCandidateOptions } from "./candidate.js";
import { prepareTrainingSessionSlot } from "./slot.js";

export interface ActivateTrainingExecutionOptions {
  execution: unknown;
  context: TrainingContext;
  /** Registered integration owns case checks/domain settings, never compiler operations. */
  prepareCase: NonNullable<LowerTrainingMomentsOptions["prepareCase"]>;
}
const receiptSchema = z.object({
  version: z.literal("spawnfile.training-activation.v1"), identity: z.unknown(),
  context: trainingContextSchema,
  files: z.array(z.object({ destination: z.string(), sha256: z.string(), size: z.number() }).strict()).min(1),
  datasets: z.object({ train: z.string(), validation: z.string().optional(), test: z.string() }).strict()
}).strict();
const save = async (file: string, value: unknown): Promise<void> => {
  const handle = await open(file, "wx", 0o400);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  const parent = await open(path.dirname(file), "r");
  try { await parent.sync(); } finally { await parent.close(); }
};
const pins = async (root: string) => (await sealTree(root, "")).map(({ destination, sha256, size }) => ({ destination, sha256, size }));

/** Receive the protected declaration using public compiler owners before any evaluation starts. */
export const activateTrainingExecution = async (options: ActivateTrainingExecutionOptions) => {
  const execution = trainingExecutionSchema.parse(options.execution);
  const context = trainingContextSchema.parse(options.context);
  if (!execution.session) throw Error("Declared training activation requires a leased session");
  if (!execution.sourceRoot || !within(execution.sourceRoot, context.project.root)) throw Error("Declared session requires its enclosing source root");
  const sourceRoot = await exactPath(execution.sourceRoot);
  if (execution.args.includes("--dry-run")) throw Error("Declared execution dry-run belongs to the host estimator");
  if (execution.output !== path.resolve(execution.output) || execution.args.filter(value => value === "--out").length !== 1 ||
    execution.args[execution.args.indexOf("--out") + 1] !== execution.output) throw Error("Execution output differs from its arguments");
  const project = await loadTrainingProject(execution.authoring.project.manifest);
  const plan = resolveTrainingPlan(project, execution.authoring.agent.id, execution.authoring.producer.version);
  if (!isDeepStrictEqual(plan, execution.authoring)) throw Error("Execution authoring differs from the canonical training declaration");
  const canonical = await createTrainingContext(project.manifest, { agent: plan.agent.id, packageVersion: context.producer.version });
  if (!isDeepStrictEqual(canonical, context)) throw Error("Execution context differs from the canonical source identity");
  const expectedPins = [...new Set(plan.targets.flatMap(target => Object.values(target.datasets)
    .flatMap(dataset => dataset === null ? [] : [dataset.sourcePath])))].sort()
    .map(sourcePath => ({ sourcePath, sha256: project.datasets[sourcePath]!.sha256 }));
  if (!isDeepStrictEqual([...execution.datasetPins].sort((left, right) => (left.sourcePath < right.sourcePath ? -1 : left.sourcePath > right.sourcePath ? 1 : 0)), expectedPins)) {
    throw Error("Execution dataset pins differ from the complete canonical datasets");
  }
  // The writable output mount holds evaluator-only lowered evidence, separate from mutable leased-slot state.
  await exactPath(execution.output);
  const control = path.join(execution.output, ".spawnfile-execution"), out = path.join(control, "moments");
  const receiptFile = path.join(control, "receipt.json"), identity = trainingExecutionIdentity(execution);
  let datasets: { train: string; validation?: string; test: string };
  if (execution.args.includes("--resume")) {
    await exactPath(control); await exactPath(receiptFile);
    const receipt = receiptSchema.parse(JSON.parse(await readFile(receiptFile, "utf8")));
    if (!isDeepStrictEqual(receipt.identity, identity) || !isDeepStrictEqual(receipt.context, context)) {
      throw Error("Resume execution differs from its immutable activation receipt");
    }
    if (!isDeepStrictEqual(await pins(out), receipt.files)) throw Error("Resume lowered moment evidence differs from its pinned bytes");
    const expectedDatasets = { train: path.join(out, "train.paideia.json"),
      ...(plan.targets.some(target => target.datasets.validation !== null) ? { validation: path.join(out, "validation.paideia.json") } : {}),
      test: path.join(out, "test.paideia.json") };
    if (!isDeepStrictEqual(receipt.datasets, expectedDatasets)) throw Error("Resume dataset roles or location differ from activation");
    datasets = receipt.datasets;
  } else {
    await mkdir(control, { mode: 0o700 });
    if (await realpath(control) !== control) throw Error("Execution control directory must be canonical");
    datasets = (await lowerTrainingMoments({ project, plan, out, prepareCase: options.prepareCase })).datasets;
    await save(receiptFile, { version: "spawnfile.training-activation.v1", identity, context, files: await pins(out), datasets });
  }
  const args = [...execution.args];
  for (const role of ["train", "validation", "test"] as const) {
    const index = args.indexOf(`--${role}`), file = datasets[role];
    if (file) {
      if (index < 0) args.push(`--${role}`, file);
      else args[index + 1] = file;
    } else if (index >= 0) throw Error("Execution requests an undeclared dataset role");
  }
  const editablePaths = [...new Set(plan.targets.flatMap(target => target.files.map(file => file.path)))];
  return { execution, identity, args, datasets,
    operations: {
      compileTrainingCandidate: async (input: Omit<CompileTrainingCandidateOptions, "editablePaths" | "sourceRoot">) => {
        if (!isDeepStrictEqual(input.context, context)) throw Error("Candidate context differs from the activated canonical identity");
        return compileTrainingCandidate({ ...input, context, editablePaths, sourceRoot });
      },
      prepareTrainingSessionSlot
    },
    materializeTrainingCase: (input: Omit<Parameters<typeof materializeTrainingCase>[0], "project" | "plan">) =>
      materializeTrainingCase({ ...input, project, plan }) };
};
export type ActivatedTrainingExecution = Awaited<ReturnType<typeof activateTrainingExecution>>;
