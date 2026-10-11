import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LoadedTrainingProject, TrainingPlan } from "../plan/index.js";
import { materializedMomentSchema, type MaterializedInput, type MaterializedMoment } from "./contract.js";
import { type MomentRecord } from "../../../recording/index.js";
import { materializeFeed } from "./feed.js";
import { materializeGit } from "./git.js";
import { historyKey, inside, openHistory, type History } from "./history.js";
import { resolveRewindInputs } from "./inputs.js";
import { inspectTrainingMoment, type LeakCheckOptions } from "./leakCheck.js";
import { inspectBundleFiles, restoreInspectedAccessTimes, snapshotBundleFiles } from "./leakFiles.js";
import { materializeMemory } from "./memory.js";
import { materializeMoltnet } from "./moltnet.js";
import { matchingMomentRecords, originalMomentRecords, selectMomentRecord } from "./select.js";
import { hasRecordPin, recordForInput } from "./recordInput.js";
import { assertTaskClockInstant, createTaskClock } from "./taskClock.js";
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
  assertTaskClockInstant(resolved.at);
  const candidateRecords = originalMomentRecords(matchingMomentRecords(records, plan.agent.id, resolved.at));
  const record = selectMomentRecord(candidateRecords, plan.agent.id, resolved.at, resolved.inputs.filter((input) => !input.overridden));
  const effectiveAt = record?.wake.startedAt ?? resolved.at;
  assertTaskClockInstant(effectiveAt);
  return { ...resolved, candidateRecords, record, effectiveAt };
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
    await stampTree(path.join(staging, "leak-check.json"), moment.effectiveAt, moment.effectiveAt);
  } else await discardPayload(staging, moment);
  await writeFile(path.join(staging, "moment.json"), serialize(materializedMomentSchema.parse(moment)));
  await stampTree(path.join(staging, "moment.json"), moment.effectiveAt, moment.effectiveAt);
  await utimes(staging, new Date(moment.effectiveAt), new Date(moment.effectiveAt));
  await restoreAccessTimes(staging, moment.effectiveAt);
  await assertEmptyOutput(out);
  await rename(staging, out);
  if (check?.ok) {
    // The post-restoration, post-rename payload is the acceptance target.
    try {
      const files = await snapshotBundleFiles(out);
      const published = { ...check, checked: { ...check.checked, files: 0 }, findings: [] as typeof check.findings };
      try { await inspectBundleFiles(out, moment.inputs, published, files); }
      finally { await restoreInspectedAccessTimes(files); }
      if (published.findings.length) {
        check.findings.push(...published.findings); check.ok = false;
        moment.leakCheck = { ok: false, findings: check.findings.length };
        for (const finding of published.findings) for (const input of moment.inputs.filter((entry) => !finding.input
          || entry.section === finding.input.section && entry.id === finding.input.id && entry.declaredBy === finding.input.declaredBy)) {
          input.refusal = `${finding.class}: ${finding.path}: ${finding.detail}`;
        }
        await discardPayload(out, moment);
        await writeFile(path.join(out, "moment.json"), serialize(materializedMomentSchema.parse(moment)));
        await stampTree(path.join(out, "moment.json"), moment.effectiveAt, moment.effectiveAt);
      }
      check.checked.files = published.checked.files;
      await writeFile(path.join(out, "leak-check.json"), serialize(check));
      await stampTree(path.join(out, "leak-check.json"), moment.effectiveAt, moment.effectiveAt);
      await utimes(out, new Date(moment.effectiveAt), new Date(moment.effectiveAt));
    } catch (error) {
      await rm(out, { recursive: true, force: true });
      throw error;
    }
  }
  return moment;
};

/** Local-only rewind. No compilation artifacts, model invocation, auth, shell or network access. */
export const materializeTrainingMoment = async (options: MaterializeTrainingMomentOptions): Promise<MaterializedMoment> => {
  const { plan, project, example } = options;
  const resolved = resolveRewindInputs(plan, project, example);
  assertTaskClockInstant(resolved.at);
  let out = path.resolve(options.out);
  await assertEmptyOutput(out);
  let history: History | undefined, historyError: string | undefined;
  try { history = await openHistory(options.historyDir); }
  catch (error) { historyError = `Cannot open history: ${reason(error)}`; }
  let record: MomentRecord | null = null, recordError: string | undefined;
  let candidateRecords: MomentRecord[] = [];
  try {
    candidateRecords = matchingMomentRecords(await history?.records() ?? [], plan.agent.id, resolved.at);
    record = selectMomentRecord(candidateRecords, plan.agent.id, resolved.at,
      resolved.inputs.filter((input) => !input.overridden));
  } catch (error) { recordError = reason(error); }
  const attempts = candidateRecords.length;
  candidateRecords = originalMomentRecords(candidateRecords);
  const effectiveAt = record?.wake.startedAt ?? resolved.at;
  assertTaskClockInstant(effectiveAt);
  await mkdir(path.dirname(out), { recursive: true });
  out = path.join(await realpath(path.dirname(out)), path.basename(out));
  if (history && (inside(history.root, out) || inside(out, history.root))) throw new Error("Rewind output and history must not overlap");
  const staging = await mkdtemp(path.join(path.dirname(out), `.${path.basename(out)}.rewind-`));
  try {
    const moment: MaterializedMoment = {
      version: "spawnfile.materialized-moment.v1", status: "materialized", agent: plan.agent.id,
      example: { id: resolved.selected.id, role: resolved.selected.role, dataset: resolved.selected.dataset },
      at: resolved.at, effectiveAt, inputs: [], record: { matched: record !== null, ...(record ? {
        attempts, selectedStartedAt: record.wake.startedAt, executionId: record.wake.executionId, selection: "earliest-startedAt" as const
      } : {}) }, leakCheck: { ok: false, findings: 0 }
    };
    for (const input of resolved.inputs) {
      const entry = reportInput(input);
      moment.inputs.push(entry);
      try {
        if (!input.overridden && (historyError || recordError)) throw new Error(historyError ?? recordError);
        const relative = `${input.section === "networks" ? "moltnet" : input.section}/${historyKey(input)}`;
        const destination = path.join(staging, relative);
        const usableRecord = recordForInput(record, input);
        const result = await dispatch({ input, at: effectiveAt, agentSlug: resolved.agentSlug, agentId: plan.agent.id,
          record: usableRecord, candidateRecords: candidateRecords.filter((candidate) => recordForInput(candidate, input)), history, destination });
        if (record && !record.exact && !input.overridden && !hasRecordPin(usableRecord, input)) {
          result.fidelity = "approximate";
          result.notes.push(...(record.errors ?? []));
        }
        await stampTree(destination, result.instant, effectiveAt);
        Object.assign(entry, { fidelity: result.fidelity, basis: result.basis, source: result.source,
          notes: result.notes, path: relative, ...(result.build ? { build: result.build } : {}) });
      } catch (error) {
        entry.refusal = reason(error);
        moment.status = "refused";
      }
    }
    if (recordError && resolved.inputs.length === 0) throw new Error(recordError);
    await writeFile(path.join(staging, "task-clock.json"), serialize(createTaskClock(effectiveAt)));
    await writeFile(path.join(staging, "moment.json"), serialize(moment));
    // Set only unstamped wrapper directories; per-input source times remain intact.
    const wrappers = async (directory: string): Promise<void> => {
      const relative = path.relative(staging, directory).split(path.sep).join("/");
      if (moment.inputs.some((input) => input.path === relative)) return;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) await wrappers(path.join(directory, entry.name));
        else if (directory === staging) await stampTree(path.join(directory, entry.name), effectiveAt, effectiveAt);
      }
      await utimes(directory, new Date(effectiveAt), new Date(effectiveAt));
    };
    await wrappers(staging);
    return await finalizeTrainingMoment(staging, out, { historyDir: options.historyDir });
  } finally { await rm(staging, { recursive: true, force: true }); }
};
