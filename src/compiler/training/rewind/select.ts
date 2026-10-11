import type { TrainingPlan } from "../plan/index.js";
import type { MomentRecord } from "./contract.js";
import { compareInstants, normalizeInstant } from "./instant.js";
import type { InputIdentity, RewindInput } from "./types.js";

export type DatasetRole = "train" | "validation" | "test";
export interface SelectedExample {
  id: string; role: DatasetRole; dataset: string; sourcePath: string;
  example: TrainingPlan["targets"][number]["datasets"]["train"]["examples"][number];
}
/** Shared targets referencing the same role/dataset/example are one trial. */
export const selectTrainingExample = (plan: TrainingPlan, selector: string): SelectedExample => {
  const match = /^(train|validation|test):(.*)$/u.exec(selector);
  const role = match?.[1], id = match?.[2] ?? selector;
  const candidates = new Map<string, SelectedExample>();
  for (const target of plan.targets) for (const candidateRole of ["train", "validation", "test"] as const) {
    const dataset = target.datasets[candidateRole];
    if (!dataset || (role && candidateRole !== role)) continue;
    for (const example of dataset.examples) {
      if (example.id !== id) continue;
      const candidate = { id, role: candidateRole, dataset: dataset.path, sourcePath: dataset.sourcePath, example };
      candidates.set(JSON.stringify([candidateRole, dataset.sourcePath, id]), candidate);
    }
  }
  const found = [...candidates.values()];
  if (found.length !== 1) throw new Error(found.length === 0
    ? `No training example matches ${selector}`
    : `Ambiguous training example ${selector}; candidates: ${found.map((item) => `${item.role}:${id} (${item.dataset})`).sort().join(", ")}`);
  return found[0]!;
};
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

export const matchingMomentRecords = (records: readonly MomentRecord[], agent: string, at: string): MomentRecord[] =>
  records.filter((record) => record.agent === agent && compareInstants(record.wake.at, at) === 0);

/** Replays keep the wake identity but later attempts have different pins. Only the original is relevant. */
export const originalMomentRecords = (records: readonly MomentRecord[]): MomentRecord[] => {
  const first = records.reduce<MomentRecord | null>((earliest, entry) =>
    !earliest || compareInstants(entry.wake.startedAt, earliest.wake.startedAt) < 0 ? entry : earliest, null);
  return first ? records.filter((entry) => compareInstants(entry.wake.startedAt, first.wake.startedAt) === 0) : [];
};

/** Capture time and wake payload are not used to materialize data. Normalize actual used instants. */
export const selectMomentRecord = (
  records: MomentRecord[], agent: string, at: string, inputs?: Array<InputIdentity | RewindInput>
): MomentRecord | null => {
  const matches = originalMomentRecords(matchingMomentRecords(records, agent, at));
  if (!matches.length) return null;
  const includes = (section: InputIdentity["section"], id: string, declaredBy?: string, field?: "resources" | "feeds" | "volumes"): boolean =>
    !inputs || inputs.some((input) => {
      if (input.section !== section || input.id !== id || (declaredBy && input.declaredBy !== declaredBy)) return false;
      if (!("declaration" in input)) return true;
      if (input.overridden) return false;
      if (input.section !== "resources" || !field) return true;
      const resource = input.declaration;
      if (field === "feeds") return resource.kind === "volume" && Boolean(resource.feed);
      if (field === "volumes") return resource.kind === "volume" && !resource.feed;
      if (resource.kind === "volume") return false;
      // Retained bundle digests take precedence over even a pinned build source.
      if (resource.kind === "bundle") return true;
      const ref = resource.ref;
      return !ref || !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/u.test(ref);
    });
  const sort = <T>(entries: T[]): T[] => entries.sort((a, b) => canonical(a).localeCompare(canonical(b)));
  const used = (record: MomentRecord): string => canonical({
    resources: sort(record.resources.filter((item) => includes("resources", item.id, undefined, "resources"))),
    feeds: sort(record.feeds.filter((item) => includes("resources", item.id, undefined, "feeds")).map((item) => ({
      ...item, landedAt: normalizeInstant(item.landedAt)
    }))),
    memory: sort(record.memory.filter((item) => includes("memory", item.id, item.declaredBy))),
    moltnet: sort(record.moltnet.filter((item) => includes("networks", item.network)).map((item) => ({ ...item, cursor: normalizeInstant(item.cursor) }))),
    volumes: sort(record.volumes.filter((item) => includes("resources", item.id, undefined, "volumes")))
  });
  if (matches.some((record) => used(record) !== used(matches[0]!))) throw new Error(`Conflicting moment records for ${agent} at ${normalizeInstant(at)}`);
  return matches[0]!;
};
