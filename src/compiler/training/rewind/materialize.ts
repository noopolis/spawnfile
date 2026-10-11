import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LoadedTrainingProject, TrainingPlan } from "../plan/index.js";
import { materializedMomentSchema, type MaterializedInput, type MaterializedMoment, type MomentRecord } from "./contract.js";
import { materializeFeed } from "./feed.js";
import { materializeGit } from "./git.js";
import { historyKey, inside, openHistory, type History } from "./history.js";
import { resolveRewindInputs } from "./inputs.js";
import { inspectTrainingMoment, type LeakCheckOptions } from "./leakCheck.js";
import { materializeMemory } from "./memory.js";
import { materializeMoltnet } from "./moltnet.js";
import { matchingMomentRecords, selectMomentRecord } from "./select.js";
import { createTaskClock } from "./taskClock.js";
import { restoreAccessTimes, stampTree } from "./timestamps.js";
import type { InputContext, InputResult, RewindInput } from "./types.js";
import { materializeVolume } from "./volumes.js";

export interface MaterializeTrainingMomentOptions {
  plan: TrainingPlan;
  project: LoadedTrainingProject;
  example: string;
  historyDir?: string;
  out: string;
}

/** Pure core for a per-trial caller: effective declarations, example identity and matching record. */
export const resolveTrainingMoment = (
  plan: TrainingPlan, project: LoadedTrainingProject, example: string, records: MomentRecord[] = []
) => {
  const resolved = resolveRewindInputs(plan, project, example);
  const candidateRecords = matchingMomentRecords(records, plan.agent.id, resolved.at);
  return { ...resolved, candidateRecords, record: selectMomentRecord(candidateRecords, plan.agent.id, resolved.at,
    resolved.inputs.filter((input) => !input.overridden)) };
};

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);
const serialize = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const kindOf = (input: RewindInput): MaterializedInput["kind"] => input.section === "memory" ? "memory"
  : input.section === "networks" ? "moltnet" : input.declaration.kind === "volume" && input.declaration.feed ? "feed" : input.declaration.kind;
const reportInput = (input: RewindInput): MaterializedInput => ({
  section: input.section, id: input.id, declaredBy: input.declaredBy, kind: kindOf(input), fidelity: null,
  basis: "refused", source: {}, path: null, notes: [], refusal: null
});
const dispatch = (context: InputContext): Promise<InputResult> => {
  const { input } = context;
  if (input.section === "memory") return materializeMemory(context);
  if (input.section === "networks") return materializeMoltnet(context);
  if (input.declaration.kind !== "volume") return materializeGit(context);
  return input.declaration.feed ? materializeFeed(context) : materializeVolume(context);
};

const assertEmptyOutput = async (out: string): Promise<void> => {
  const existing = await lstat(out).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing && (!existing.isDirectory() || (await readdir(out)).length)) throw new Error("Rewind --out must not exist or must be an empty directory");
};

const discardPayload = async (staging: string, moment: MaterializedMoment): Promise<void> => {
  moment.status = "refused";
  for (const input of moment.inputs) input.path = null;
  for (const name of await readdir(staging)) if (name !== "moment.json" && name !== "leak-check.json") {
    await rm(path.join(staging, name), { recursive: true, force: true });
  }
};

/** A separately callable disk acceptance gate, also used to test deliberately broken producers. */
export const finalizeTrainingMoment = async (staging: string, out: string, options: LeakCheckOptions = {}): Promise<MaterializedMoment> => {
  // Capture disk metadata before reading even moment.json; inspection preserves access times.
  const { moment, check } = await inspectTrainingMoment(staging, options, true);
  if (check) {
    moment.leakCheck = { ok: check.ok, findings: check.findings.length };
    if (!check.ok) {
      for (const finding of check.findings) {
        const affected = finding.input ? moment.inputs.filter((input) => input.section === finding.input!.section
          && input.id === finding.input!.id && input.declaredBy === finding.input!.declaredBy) : moment.inputs;
        for (const input of affected) input.refusal = [input.refusal, `${finding.class}: ${finding.path}: ${finding.detail}`].filter(Boolean).join("; ");
      }
      await discardPayload(staging, moment);
    }
    await writeFile(path.join(staging, "leak-check.json"), serialize(check));
    await stampTree(path.join(staging, "leak-check.json"), moment.at, moment.at);
  } else await discardPayload(staging, moment);
  await writeFile(path.join(staging, "moment.json"), serialize(materializedMomentSchema.parse(moment)));
  await stampTree(path.join(staging, "moment.json"), moment.at, moment.at);
  await utimes(staging, new Date(moment.at), new Date(moment.at));
  await restoreAccessTimes(staging, moment.at);
  await assertEmptyOutput(out);
  await rename(staging, out);
  return moment;
};

/** Local-only rewind. No compilation artifacts, model invocation, auth, shell or network access. */
export const materializeTrainingMoment = async (options: MaterializeTrainingMomentOptions): Promise<MaterializedMoment> => {
  const { plan, project, example } = options;
  const resolved = resolveRewindInputs(plan, project, example);
  let out = path.resolve(options.out);
  await assertEmptyOutput(out);
  let history: History | undefined, historyError: string | undefined;
  try { history = await openHistory(options.historyDir); }
  catch (error) { historyError = `Cannot open history: ${reason(error)}`; }
  await mkdir(path.dirname(out), { recursive: true });
  out = path.join(await realpath(path.dirname(out)), path.basename(out));
  if (history && (inside(history.root, out) || inside(out, history.root))) throw new Error("Rewind output and history must not overlap");
  const staging = await mkdtemp(path.join(path.dirname(out), `.${path.basename(out)}.rewind-`));
  try {
    let record: MomentRecord | null = null, recordError: string | undefined;
    let candidateRecords: MomentRecord[] = [];
    try {
      candidateRecords = matchingMomentRecords(await history?.records() ?? [], plan.agent.id, resolved.at);
      record = selectMomentRecord(candidateRecords, plan.agent.id, resolved.at,
        resolved.inputs.filter((input) => !input.overridden));
    } catch (error) { recordError = reason(error); }
    const moment: MaterializedMoment = {
      version: "spawnfile.materialized-moment.v1", status: "materialized", agent: plan.agent.id,
      example: { id: resolved.selected.id, role: resolved.selected.role, dataset: resolved.selected.dataset },
      at: resolved.at, inputs: [], record: { matched: record !== null }, leakCheck: { ok: false, findings: 0 }
    };
    for (const input of resolved.inputs) {
      const entry = reportInput(input);
      moment.inputs.push(entry);
      try {
        if (!input.overridden && (historyError || recordError)) throw new Error(historyError ?? recordError);
        const relative = `${input.section === "networks" ? "moltnet" : input.section}/${historyKey(input)}`;
        const destination = path.join(staging, relative);
        const result = await dispatch({ input, at: resolved.at, record, candidateRecords, history, destination });
        await stampTree(destination, result.instant, resolved.at);
        Object.assign(entry, { fidelity: result.fidelity, basis: result.basis, source: result.source,
          notes: result.notes, path: relative, ...(result.build ? { build: result.build } : {}) });
      } catch (error) {
        entry.refusal = reason(error);
        moment.status = "refused";
      }
    }
    if (recordError && resolved.inputs.length === 0) throw new Error(recordError);
    await writeFile(path.join(staging, "task-clock.json"), serialize(createTaskClock(resolved.at)));
    await writeFile(path.join(staging, "moment.json"), serialize(moment));
    // Set only unstamped wrapper directories; per-input source times remain intact.
    const wrappers = async (directory: string): Promise<void> => {
      const relative = path.relative(staging, directory).split(path.sep).join("/");
      if (moment.inputs.some((input) => input.path === relative)) return;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) await wrappers(path.join(directory, entry.name));
        else if (directory === staging) await stampTree(path.join(directory, entry.name), resolved.at, resolved.at);
      }
      await utimes(directory, new Date(resolved.at), new Date(resolved.at));
    };
    await wrappers(staging);
    return await finalizeTrainingMoment(staging, out, { historyDir: options.historyDir });
  } finally { await rm(staging, { recursive: true, force: true }); }
};
