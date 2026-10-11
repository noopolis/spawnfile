import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { historyKey } from "./history.js";
import { compareInstants } from "./instant.js";
import { parseMemoryLedgerEvent, memoryGenerationSchema, type MemoryGeneration, type MemoryLedgerEvent } from "./memorySchemas.js";
import type { InputContext, InputResult } from "./types.js";

export interface MemoryLedger { lines: string[]; events: MemoryLedgerEvent[] }
const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const parseMemoryLedger = (payload: string, label = "memory/events.jsonl"): MemoryLedger => {
  if (payload === "") return { lines: [], events: [] };
  if (!payload.endsWith("\n")) throw new Error(`${label}: ledger must end with LF`);
  const lines = payload.slice(0, -1).split("\n");
  const events = lines.map((line, index) => {
    try { return parseMemoryLedgerEvent(line); }
    catch (error) { throw new Error(`${label}:${index + 1}: invalid Mneme event: ${reason(error)}`); }
  });
  return { lines, events };
};

/** The first future event is a boundary; a clock regression after it cannot reopen the cut. */
export const selectMemoryPrefix = (ledger: MemoryLedger, at: string, seq?: number): MemoryLedger => {
  if (seq !== undefined && (!Number.isSafeInteger(seq) || seq < 0 || seq > ledger.events.length)) {
    throw new Error(`Memory record seq ${seq} exceeds or does not identify a ledger prefix`);
  }
  const firstFuture = ledger.events.findIndex((event) => compareInstants(event.createdAt, at) > 0);
  const length = seq ?? (firstFuture < 0 ? ledger.events.length : firstFuture);
  const events = ledger.events.slice(0, length);
  let sawNative = false;
  events.forEach((event, index) => {
    if (event.seq !== undefined) {
      if (event.seq !== index + 1) throw new Error(`Memory ledger line ${index + 1}: seq ${event.seq} is not contiguous`);
      sawNative = true;
    } else if (sawNative) throw new Error(`Memory ledger line ${index + 1}: seq-less legacy events must form a leading run`);
    if (compareInstants(event.createdAt, at) > 0) throw new Error(`Memory ledger line ${index + 1}: createdAt is later than the moment`);
    if (index > 0 && compareInstants(event.createdAt, events[index - 1]!.createdAt) < 0) {
      throw new Error(`Memory ledger line ${index + 1}: createdAt regresses within the selected prefix`);
    }
  });
  return { events, lines: ledger.lines.slice(0, length) };
};

export const selectMemoryGeneration = (
  generations: MemoryGeneration[] | null, at: string, recordGeneration?: number
): { generation: number; ledger: string; switchedAt: string | null } => {
  // With no curation log, only the original generation can be established.
  let selected: { generation: number; ledger: string; switchedAt: string | null } = {
    generation: 0, ledger: "events.jsonl", switchedAt: null
  };
  if (generations !== null) {
    const known = new Map<number, MemoryGeneration>();
    for (const generation of generations) {
      const prior = known.get(generation.generation);
      if (prior && JSON.stringify(prior) !== JSON.stringify(generation)) {
        throw new Error(`Conflicting memory generation ${generation.generation}`);
      }
      known.set(generation.generation, generation);
    }
    const eligible = [...known.values()].filter((entry) => compareInstants(entry.switchedAt, at) <= 0)
      .sort((a, b) => compareInstants(b.switchedAt, a.switchedAt));
    if (!eligible.length) throw new Error("No memory generation switched at or before the moment; an archived ledger is required");
    if (eligible[1] && compareInstants(eligible[0]!.switchedAt, eligible[1].switchedAt) === 0) {
      throw new Error("Ambiguous memory generations switched at the same instant");
    }
    selected = eligible[0]!;
  }
  if (recordGeneration !== undefined && recordGeneration !== selected.generation) {
    throw new Error(`Memory record generation ${recordGeneration} disagrees with selected generation ${selected.generation}`);
  }
  return selected;
};

export const materializeMemory = async (context: InputContext): Promise<InputResult> => {
  const { input, at, record, history, destination } = context;
  if (input.section !== "memory") throw new Error("Memory materialization requires a memory input");
  const directory = path.join(destination, "memory");
  if (input.overridden) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "events.jsonl"), "");
    return { fidelity: "overridden", basis: "override", source: { seq: 0, generation: 0 }, notes: [], instant: at };
  }
  if (!history) throw new Error(`Memory bank ${input.id} requires --history or an override`);
  const base = `memory/${historyKey(input)}`;
  const pin = record?.memory.find((entry) => entry.id === input.id && entry.declaredBy === input.declaredBy);
  const generation = selectMemoryGeneration(await history.jsonl(`${base}/generations.jsonl`, memoryGenerationSchema), at, pin?.generation);
  const ledgerPath = `${base}/${generation.ledger}`;
  const payload = await history.text(ledgerPath);
  if (payload === null) throw new Error(`Missing memory ledger ${ledgerPath}; an archived ledger is required for this generation`);
  const prefix = selectMemoryPrefix(parseMemoryLedger(payload, ledgerPath), at, pin?.seq);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "events.jsonl"), prefix.lines.length ? `${prefix.lines.join("\n")}\n` : "");
  return {
    fidelity: pin ? "exact" : "approximate", basis: pin ? "record" : "created-at-prefix",
    source: { seq: prefix.events.length, generation: generation.generation },
    notes: ["Spawnfile structurally validated the selected ledger without a Mneme runtime dependency; no derived or authority audit state is included.",
      "Mneme 0.1.1 rebuilds its index from the ledger before every index read.",
      "Checksum verification is skipped: Mneme 0.1.1 hashes the original input before normalization, which cannot be reconstructed exactly from stored events.",
      ...(generation.switchedAt === null ? ["No generation history: the current ledger is treated as original generation 0."] : [])],
    instant: prefix.events.at(-1)?.createdAt ?? generation.switchedAt ?? at
  };
};
