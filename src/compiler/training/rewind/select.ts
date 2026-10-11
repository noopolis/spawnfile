import type { TrainingPlan } from "../plan/index.js";
import type { MomentRecord } from "../../../recording/index.js";
import { compareInstants, normalizeInstant } from "./instant.js";
import { hasRecordPin, recordForInput, recordPins } from "./recordInput.js";
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

/** Replays can share executionId AND startedAt. Keep every earliest tie for per-input agreement. */
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
  const identities: Array<InputIdentity | RewindInput> = inputs ?? matches.flatMap((record): InputIdentity[] => [
    ...[...record.resources, ...record.feeds, ...record.volumes].map(({ id }) => ({ section: "resources" as const, id, declaredBy: agent })),
    ...record.memory.map(({ id, declaredBy }) => ({ section: "memory" as const, id, declaredBy })),
    ...record.moltnet.map(({ network }) => ({ section: "networks" as const, id: network, declaredBy: agent }))
  ]);
  for (const input of identities) {
    if ("overridden" in input && input.overridden) continue;
    const declaredPin = "declaration" in input && input.section === "resources" && input.declaration.kind === "git"
      && /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/u.test(input.declaration.ref ?? "");
    const decision = (record: MomentRecord): string => {
      const usable = recordForInput(record, input);
      const pins = recordPins(usable, input).map((pin) => "landedAt" in pin ? { ...pin, landedAt: normalizeInstant(pin.landedAt) }
        : "cursor" in pin ? { ...pin, cursor: normalizeInstant(pin.cursor) } : pin);
      return canonical({ pin: declaredPin ? "declared-pin" : pins.sort((a, b) => canonical(a).localeCompare(canonical(b))),
        approximateFallback: !record.exact && !hasRecordPin(usable, input) });
    };
    if (matches.some((record) => decision(record) !== decision(matches[0]!))) {
      throw new Error(`Conflicting moment records for ${agent} at ${normalizeInstant(at)}: ${input.section} ${input.declaredBy}/${input.id} has different effective pin/fallback decisions`);
    }
  }
  return matches[0]!;
};
