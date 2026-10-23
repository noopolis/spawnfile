import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { LoadedTrainingProject, TrainingPlan } from "./plan/index.js";
import { materializeTrainingMoment } from "./rewind/materialize.js";
import { normalizeInstant } from "./rewind/instant.js";
import { materializedMomentSchema, type MaterializedMoment } from "./rewind/contract.js";

export type TrainingDatasetRole = "train" | "validation" | "test";
type Example = TrainingPlan["targets"][number]["datasets"]["train"]["examples"][number];
export interface TrainingMomentCase {
  version: "spawnfile.training-moment-case.v1";
  projectRoot: string; agent: string; example: string; role: TrainingDatasetRole;
  dataset: string; at: string; effectiveAt: string; wake: Example["wake"];
  group: string; lineage: string; momentRoot: string; historyDir?: string; hook: string;
}
export interface PreparedTrainingCase {
  setup?: Record<string, unknown>; context?: Record<string, unknown>; reference?: Record<string, unknown>;
  outputs?: Record<string, string>; checks?: unknown[]; stages?: unknown[];
}
export interface TrainingCasePreparation {
  moment: MaterializedMoment; momentRoot: string; example: Example; role: TrainingDatasetRole;
  dataset: string; group: string; lineage: string;
}
export interface LowerTrainingMomentsOptions {
  project: LoadedTrainingProject; plan: TrainingPlan; out: string; historyDir?: string;
  /** Named integration's case authoring only; never credentials or live subject execution. */
  prepareCase?: (context: TrainingCasePreparation) => Promise<PreparedTrainingCase>;
}
export interface TrainingMomentLoweringEntry {
  id: string; role: TrainingDatasetRole; dataset: string; at: string; wake: Example["wake"];
  group: string; lineage: string | null; momentRoot: string; status: "materialized" | "refused";
  moment?: MaterializedMoment; reason?: string;
}
const roles = ["train", "validation", "test"] as const;
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const save = (file: string, value: unknown): Promise<void> => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });

/** Rewind each authored example exactly once; repeated target references share one case. */
export const lowerTrainingMoments = async (options: LowerTrainingMomentsOptions) => {
  const { project, plan } = options;
  const out = path.resolve(options.out);
  // A fresh root is intentional: resume must use the persisted lowered dataset, never overwrite it.
  await mkdir(out, { mode: 0o700 });
  const entries: TrainingMomentLoweringEntry[] = [];
  const records: Record<TrainingDatasetRole, Record<string, unknown>[]> = { train: [], validation: [], test: [] };
  const seen = new Set<string>(), declared = new Set<TrainingDatasetRole>();
  const historyDir = options.historyDir ?? plan.preparation?.history;
  for (const role of roles) for (const target of plan.targets) {
    const dataset = target.datasets[role];
    if (!dataset) continue;
    declared.add(role);
    for (const example of dataset.examples) {
      const identity = JSON.stringify([role, dataset.sourcePath, example.id]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      // Group follows the authored example's identity, not its split, preventing split leakage.
      const group = `moment:${hash([plan.agent.id, example.id])}`;
      const momentRoot = path.join(out, "moments", role, hash(identity));
      const entry: TrainingMomentLoweringEntry = { id: example.id, role, dataset: dataset.path, at: example.at,
        wake: example.wake, group, lineage: null, momentRoot, status: "refused" };
      entries.push(entry);
      try {
        const lineage = `moment:${hash([plan.agent.id, normalizeInstant(example.at), example.wake])}`;
        entry.lineage = lineage;
        // Scope the selector to this dataset; different datasets may use the same example ID.
        const scoped = { ...plan, targets: [{ ...target, datasets: { ...target.datasets, [role]: dataset } }] };
        const moment = await materializeTrainingMoment({ project, plan: scoped, example: `${role}:${example.id}`, historyDir, out: momentRoot });
        entry.moment = moment;
        if (moment.status === "refused") {
          entry.reason = moment.inputs.flatMap(input => input.refusal ? [input.refusal] : []).join("; ") || "Rewind leak check refused the example";
          continue;
        }
        const prepared = await options.prepareCase?.({ moment, momentRoot, example, role, dataset: dataset.path, group, lineage }) ?? {};
        if (!prepared.checks?.length && !prepared.stages?.length) throw new Error("Moment case hook must supply terminal checks or stages");
        const trainingMoment: TrainingMomentCase = { version: "spawnfile.training-moment-case.v1", projectRoot: project.root,
          agent: plan.agent.id, example: `${role}:${example.id}`, role, dataset: dataset.path, at: moment.at, effectiveAt: moment.effectiveAt,
          wake: example.wake, group, lineage, momentRoot, ...(historyDir ? { historyDir } : {}),
          hook: plan.preparation?.hook ?? "spawnfile/rewind" };
        records[role].push({ ...prepared, id: example.id, group, lineage: [lineage],
          input: { message: { network: example.wake.surface, sender: example.wake.from,
            target: example.wake.room, text: example.wake.text } },
          setup: { ...prepared.setup, trainingMoment }, context: { ...prepared.context, trainingMomentProvenance: moment } });
        entry.status = "materialized";
      } catch (error) { entry.reason = error instanceof Error ? error.message : String(error); }
    }
  }
  const datasets: Partial<Record<TrainingDatasetRole, string>> = {};
  for (const role of roles) if (declared.has(role)) {
    datasets[role] = path.join(out, `${role}.spawnfile-training.json`);
    await save(datasets[role], { schema: "spawnfile.training.dataset.v1", id: `${plan.agent.id}:${role}`, subject: plan.agent.name,
      setup: { profile: plan.preparation?.hook ?? "spawnfile/rewind" }, records: records[role] });
  }
  const report = { version: "spawnfile.training-moment-lowering.v1" as const, agent: plan.agent.id, entries };
  await save(path.join(out, "lowering.json"), report);
  // Keep every refusal on disk, including an all-refused role. Never substitute another split.
  for (const role of declared) if (records[role].length === 0) throw new Error(`No executable ${role} moments; see ${path.join(out, "lowering.json")}`);
  for (const role of roles) {
    const ids = records[role].map(record => record.id);
    if (new Set(ids).size !== ids.length) throw new Error(`Duplicate executable ${role} example IDs across datasets; use unique IDs`);
  }
  return { datasets: datasets as { train: string; validation?: string; test: string }, report };
};

/** Trial hooks call this on fresh paths; historical identity must match the accepted lowering. */
export const materializeTrainingCase = async (options: {
  project: LoadedTrainingProject; plan: TrainingPlan; moment: TrainingMomentCase; out: string; expected?: MaterializedMoment;
}): Promise<MaterializedMoment> => {
  const { project, plan, moment } = options;
  if (project.root !== moment.projectRoot || plan.agent.id !== moment.agent) throw new Error("Trial moment project or agent differs from lowering");
  const targets = plan.targets.filter(target => target.datasets[moment.role]?.path === moment.dataset);
  if (!targets.length) throw new Error("Trial moment dataset is not declared");
  const example = targets[0]!.datasets[moment.role]!.examples.find(value => `${moment.role}:${value.id}` === moment.example);
  if (!example || !isDeepStrictEqual(example.wake, moment.wake) || normalizeInstant(example.at) !== normalizeInstant(moment.at)) {
    throw new Error("Trial moment wake or instant differs from lowering");
  }
  const file = path.join(moment.momentRoot, "moment.json");
  if (!options.expected) {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000) throw new Error("Accepted moment provenance must be a bounded regular file");
  }
  const expected = materializedMomentSchema.parse(options.expected ?? JSON.parse(await readFile(file, "utf8")));
  if (expected.status !== "materialized" || expected.agent !== moment.agent || expected.example.id !== example.id ||
    expected.example.role !== moment.role || expected.example.dataset !== moment.dataset || expected.at !== moment.at ||
    expected.effectiveAt !== moment.effectiveAt || !expected.leakCheck.ok) throw new Error("Accepted moment provenance differs from lowering");
  const result = await materializeTrainingMoment({ project, plan: { ...plan, targets }, example: moment.example,
    historyDir: moment.historyDir, out: options.out });
  if (result.status !== "materialized" || result.effectiveAt !== moment.effectiveAt) throw new Error("Trial rewind refused or historical start instant changed");
  if (!isDeepStrictEqual(result.inputs, expected.inputs) || !isDeepStrictEqual(result.record, expected.record)) {
    throw new Error("Trial rewind provenance differs from accepted lowering");
  }
  return result;
};
