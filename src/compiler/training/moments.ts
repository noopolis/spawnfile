import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { TrainingMomentResource } from "../../manifest/index.js";
import { SpawnfileError } from "../../shared/index.js";
import { fetchFeedSource, resolveFeedSource, type FeedProvenance, type FeedSourceSpec } from "../../volume/index.js";
import type { LoadedTrainingProject, TrainingPlan } from "./plan/index.js";
import { instantNanos } from "./rewind/instant.js";

export type TrainingDatasetRole = "train" | "validation" | "test";
export const TRAINING_MOMENT_VERSION = "spawnfile.training-moment.v1" as const;
/** The dataset preparation profile whose records carry `setup.moment`; booted training registers it. */
export const TRAINING_MOMENT_PROFILE = "spawnfile/moment" as const;
const MAX_GRADER_DIRECTORY_BYTES = 32 * 1024 * 1024;

/** A fill source pinned at lowering: a feed resolved to its revision, inline files, or nothing. */
export type TrainingMomentFill =
  | { kind: "empty" }
  | { kind: "files"; files: Record<string, string> }
  | { kind: "git"; repo: string; commit: string; paths: string[] | null; revision: string; source: FeedProvenance }
  | { kind: "directory"; directory: string; revision: string; source: FeedProvenance };

/**
 * One moment: the trial's starting state (fresh per-trial volumes, each filled from its source before boot)
 * and the one wake that starts it. It travels in the lowered record's `setup.moment`.
 */
export interface TrainingMoment {
  version: typeof TRAINING_MOMENT_VERSION;
  /** The wake's instant, exact to the millisecond, as the runtime receives it. */
  at: string;
  wake: { surface: "moltnet"; room: string; from: string; text: string };
  resources: { id: string; fill: TrainingMomentFill }[];
  /** Steps production runs in the started organization before it takes work, in order. */
  afterBoot?: { user: string; command: string[]; env?: Record<string, string> }[];
}

const fillPath = z.string().min(1).refine((value) => !value.startsWith("/") && !value.split("/").some((part) => !part || part === "." || part === ".."));
const provenance = z.union([
  z.object({ commit: z.string(), kind: z.literal("git"), paths: z.array(z.string()).nullable(), ref: z.string() }).strict(),
  z.object({ kind: z.literal("directory") }).strict()
]);
/** Validates a record's `setup.moment` where the trial boots. */
export const trainingMomentSchema = z.object({
  version: z.literal(TRAINING_MOMENT_VERSION),
  at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
  wake: z.object({ surface: z.literal("moltnet"), room: z.string(), from: z.string(), text: z.string() }).strict(),
  resources: z.array(z.object({ id: z.string().min(1), fill: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("empty") }).strict(),
    z.object({ kind: z.literal("files"), files: z.record(fillPath, z.string()) }).strict(),
    z.object({ kind: z.literal("git"), repo: z.string().min(1), commit: z.string().regex(/^[0-9a-f]{40,64}$/u),
      paths: z.array(fillPath).nullable(), revision: z.string().regex(/^[0-9a-f]{64}$/u), source: provenance }).strict(),
    z.object({ kind: z.literal("directory"), directory: z.string().min(1), revision: z.string().regex(/^[0-9a-f]{64}$/u), source: provenance }).strict()
  ]) }).strict()),
  afterBoot: z.array(z.object({ user: z.string().regex(/^\d+:\d+$/u), command: z.array(z.string().min(1)).min(1),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), z.string()).optional() }).strict()).optional()
}).strict() satisfies z.ZodType<TrainingMoment>;

export interface LowerTrainingMomentsOptions { project: LoadedTrainingProject; plan: TrainingPlan; out: string }
export type LoweredTrainingDatasets = { train: string; validation?: string; test: string };

const roles = ["train", "validation", "test"] as const;
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const invalid = (message: string): never => { throw new SpawnfileError("validation_error", message); };

/** How production Moltnet renders a room message for Daimon (`moltnet/internal/bridge/render.go`). */
export const renderMomentWake = (wake: TrainingMoment["wake"]): string => `[room ${wake.room}] ${wake.from}\n${wake.text}`.trim();

/** Daimon wakes carry an exact millisecond UTC instant. */
const wakeInstant = (at: string): string => {
  const nanos = instantNanos(at);
  return new Date(Number((nanos - ((nanos % 1_000_000n) + 1_000_000n) % 1_000_000n) / 1_000_000n)).toISOString();
};

/** A path the dataset names must stay inside the project, by realpath. */
const contained = async (root: string, base: string, relative: string, label: string): Promise<string> => {
  const file = path.resolve(base, relative);
  const real = await realpath(file).catch(() => invalid(`${label} does not exist: ${relative}`));
  const realRoot = await realpath(root);
  if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) invalid(`${label} leaves the project: ${relative}`);
  return real;
};

const fillFor = (resource: TrainingMomentResource, datasetDirectory: string): TrainingMomentFill => {
  if (resource.files) return { kind: "files", files: { ...resource.files } };
  const feed = resource.feed;
  if (!feed) return { kind: "empty" };
  const spec: FeedSourceSpec = feed.git
    ? { kind: "git", repo: path.resolve(datasetDirectory, feed.git.repo), ref: feed.git.ref as string, fetch: feed.git.fetch === true,
      ...(feed.git.paths ? { paths: feed.git.paths } : {}) }
    : { kind: "directory", directory: path.resolve(datasetDirectory, feed.directory!) };
  fetchFeedSource(spec);
  const resolved = resolveFeedSource(spec);
  if (spec.kind === "directory") return { kind: "directory", directory: spec.directory, revision: resolved.revision, source: resolved.provenance };
  const provenance = resolved.provenance as Extract<FeedProvenance, { kind: "git" }>;
  return { kind: "git", repo: spec.repo, commit: provenance.commit, paths: provenance.paths, revision: resolved.revision, source: provenance };
};

/** Copies a grader's directory beside the lowered datasets, so the grader stays a contained relative path. */
const copyGrader = async (graderFile: string, moments: string, copied: Map<string, string>): Promise<string> => {
  const directory = path.dirname(graderFile);
  let target = copied.get(directory);
  if (!target) {
    target = path.join("graders", hash(directory).slice(0, 16));
    let bytes = 0;
    for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
      const file = path.join(entry.parentPath, entry.name);
      const stat = await lstat(file);
      if (stat.isSymbolicLink()) invalid(`Grader directory holds a link: ${file}`);
      if (stat.isFile()) bytes += stat.size;
    }
    if (bytes > MAX_GRADER_DIRECTORY_BYTES) invalid(`Grader directory exceeds ${MAX_GRADER_DIRECTORY_BYTES} bytes: ${directory}`);
    await cp(directory, path.join(moments, target), { recursive: true, errorOnExist: true, force: false });
    copied.set(directory, target);
  }
  return path.posix.join(target.split(path.sep).join("/"), path.basename(graderFile));
};
/** Copies one sidecar file a declared check reads beside the lowered datasets; returns its dataset-relative path. */
const copySidecar = async (file: string, moments: string, copied: Map<string, string>): Promise<string> => {
  let target = copied.get(file);
  if (!target) {
    target = path.posix.join("sidecars", hash(file).slice(0, 16), path.basename(file));
    await mkdir(path.join(moments, path.dirname(target)), { recursive: true, mode: 0o700 });
    await cp(file, path.join(moments, target), { errorOnExist: true, force: false });
    copied.set(file, target);
  }
  return target;
};

/**
 * Lowers every authored moment example into one executable training dataset per role, under `<out>/moments`.
 * Each record carries its moment in `setup.moment`, its wake as production renders it, its grader context and
 * one grader check over its output: the declared workspace file, or the final reply.
 */
export const lowerTrainingMoments = async (options: LowerTrainingMomentsOptions): Promise<LoweredTrainingDatasets> => {
  const { project, plan } = options;
  const moments = path.join(path.resolve(options.out), "moments");
  await mkdir(path.dirname(moments), { recursive: true, mode: 0o700 });
  await mkdir(moments, { recursive: false, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") invalid(`Lowered moments already exist in ${moments}; select a fresh --out`);
    throw error;
  });
  const graders = new Map(plan.graders.map((grader) => [`${grader.declaredBy}\0${grader.name}`, grader.sourcePath]));
  const copied = new Map<string, string>();
  const records: Record<TrainingDatasetRole, Record<string, unknown>[]> = { train: [], validation: [], test: [] };
  const declared = new Set<TrainingDatasetRole>();
  const seen = new Set<string>();
  for (const role of roles) for (const target of plan.targets) {
    const dataset = target.datasets[role];
    if (!dataset) continue;
    declared.add(role);
    const loaded = project.datasets[dataset.sourcePath] ?? invalid(`Training dataset was not loaded: ${dataset.sourcePath}`);
    const base = path.dirname(dataset.sourcePath);
    const targetGrader = graders.get(`${target.declaredBy}\0${target.grader}`)
      ?? plan.graders.find((grader) => grader.name === target.grader)?.sourcePath
      ?? invalid(`Training target grader ${target.grader} was not planned`);
    for (const example of loaded.value.examples) {
      const identity = JSON.stringify([role, dataset.sourcePath, example.id]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      if (records[role].some((record) => record.id === example.id)) invalid(`Duplicate ${role} example ID ${example.id} across datasets; use unique IDs`);
      const grader = example.grader ? await contained(project.root, base, example.grader, `Example ${example.id} grader`) : targetGrader;
      const context: Record<string, string> = {};
      for (const [name, source] of Object.entries(example.context ?? {})) {
        context[name] = await readFile(await contained(project.root, base, source.file, `Example ${example.id} context ${name}`), "utf8");
      }
      const moment: TrainingMoment = {
        version: TRAINING_MOMENT_VERSION, at: wakeInstant(example.at), wake: { ...example.wake },
        resources: (example.resources ?? []).map((resource) => ({ id: resource.id, fill: fillFor(resource, base) })),
        ...(loaded.value.after_boot ? { afterBoot: loaded.value.after_boot.map((step) => ({ ...step, command: [...step.command] })) } : {})
      };
      records[role].push({
        id: example.id,
        // Group follows the authored example, not its split, so one moment never crosses splits.
        group: `moment:${hash([plan.agent.id, example.id])}`,
        input: { prompt: renderMomentWake(moment.wake) },
        setup: { moment },
        ...(Object.keys(context).length ? { context } : {}),
        ...(example.output ? { outputs: { output: example.output } } : {}),
        ...await recordChecks(example, {
          id: "grade", eval: "grader", grader: await copyGrader(grader, moments, copied),
          input: example.output ? "artifact:output" : "artifact:reply",
          ...(Object.keys(context).length ? { context: Object.fromEntries(Object.keys(context).map((name) => [name, `context:${name}`])) } : {})
        }, async (file) => copySidecar(await contained(project.root, base, file, `Example ${example.id} check source`), moments, copied))
      });
    }
  }
  const datasets: Partial<LoweredTrainingDatasets> = {};
  for (const role of roles) if (declared.has(role)) {
    const file = path.join(moments, `${role}.spawnfile-training.json`);
    // The train dataset carries the optimizer's declared provider; without one the core's default serves it.
    const optimizer = plan.optimizer;
    const training = role === "train" && optimizer?.provider ? { training: {
      models: { optimizer: { provider: optimizer.provider, model: optimizer.model } },
      optimizer: { model: "optimizer", method: optimizer.method, variants: optimizer.variants, keep: optimizer.keep, budget: { rounds: optimizer.budget.rounds } }
    } } : {};
    await writeFile(file, `${JSON.stringify({ schema: "spawnfile.training.dataset.v1", id: `${plan.agent.id}:${role}`,
      setup: { profile: TRAINING_MOMENT_PROFILE }, ...training, records: records[role] }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 });
    datasets[role] = file;
  }
  return datasets as LoweredTrainingDatasets;
};

type AuthoredExample = { checks?: Array<Record<string, unknown> & { source?: Array<string | { file: string }> }>; score?: Record<string, number>; gate?: string[] };

/**
 * The record's checks: the grader's `grade`, then the example's declared mechanical checks with their
 * sidecar sources copied. Declared weights or gates make one stage; otherwise every check must pass.
 */
const recordChecks = async (example: AuthoredExample, grade: Record<string, unknown>, sidecar: (file: string) => Promise<string>) => {
  const declared = await Promise.all((example.checks ?? []).map(async (check) => check.source === undefined ? check
    : { ...check, source: await Promise.all(check.source.map((entry) => typeof entry === "string" ? entry : sidecar(entry.file))) }));
  const checks = [grade, ...declared];
  if (!example.score && !example.gate) return { checks };
  return { stages: [{ id: "record-checks", checks,
    ...(example.score ? { score: { linear: { ...example.score } } } : {}),
    ...(example.gate ? { gate: { all: example.gate.map((id) => ({ passed: id })) } } : {}) }] };
};

/** Replaces the authored dataset locators with the lowered datasets. */
export const withLoweredDatasets = (args: readonly string[], datasets: LoweredTrainingDatasets): string[] => {
  const result: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (["--train", "--validation", "--test"].includes(args[index]!)) { index++; continue; }
    result.push(args[index]!);
  }
  for (const role of roles) if (datasets[role]) result.push(`--${role}`, datasets[role]!);
  return result;
};

/** The datasets an earlier run of this output lowered, for `--resume`. */
export const resumedMomentDatasets = (out: string, plan: TrainingPlan): LoweredTrainingDatasets => {
  const datasets: Partial<LoweredTrainingDatasets> = {};
  for (const role of roles) if (plan.targets.some((target) => target.datasets[role])) {
    datasets[role] = path.join(path.resolve(out), "moments", `${role}.spawnfile-training.json`);
  }
  return datasets as LoweredTrainingDatasets;
};
