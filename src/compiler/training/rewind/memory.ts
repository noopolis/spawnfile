import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { historyKey } from "./history.js";
import { compareInstants } from "./instant.js";
import { parseMemoryLedgerEvent, type MemoryLedgerEvent } from "./memorySchemas.js";
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

export const materializeMemory = async (context: InputContext): Promise<InputResult> => {
  const { input, at, record, history, destination } = context;
  if (input.section !== "memory") throw new Error("Memory materialization requires a memory input");
  const directory = path.join(destination, "memory");
  if (input.overridden) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "events.jsonl"), "");
    return { fidelity: "overridden", basis: "override", source: { seq: 0 }, notes: [], instant: at };
  }
  const pin = record?.memory.find((entry) => entry.id === input.id && entry.declaredBy === input.declaredBy);
  if (pin?.generation !== undefined) throw new Error(`Memory bank ${input.id}: Mneme generations are unsupported`);
  if (pin?.seq === 0) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "events.jsonl"), "");
    return { fidelity: "exact", basis: "record", source: { seq: 0 },
      notes: ["The record pins an empty bank (seq: 0); no history ledger is required."], instant: at };
  }
  if (!history) throw new Error(`Memory bank ${input.id} requires --history or an override`);
  const ledgerPath = `memory/${historyKey(input)}/events.jsonl`;
  const payload = await history.text(ledgerPath);
  if (payload === null) throw new Error(`Missing memory ledger ${ledgerPath}`);
  const prefix = selectMemoryPrefix(parseMemoryLedger(payload, ledgerPath), at, pin?.seq);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "events.jsonl"), prefix.lines.length ? `${prefix.lines.join("\n")}\n` : "");
  return {
    fidelity: pin ? "exact" : "approximate", basis: pin ? "record" : "created-at-prefix",
    source: { seq: prefix.events.length },
    notes: ["Spawnfile structurally validated the selected ledger without a Mneme runtime dependency; no derived or authority audit state is included.",
      "Mneme 0.1.1 rebuilds its index from the ledger before every index read.",
      "Checksum verification is skipped: Mneme 0.1.1 hashes the original input before normalization, which cannot be reconstructed exactly from stored events."],
    instant: prefix.events.at(-1)?.createdAt ?? at
  };
};
