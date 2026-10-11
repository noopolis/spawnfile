import { z } from "zod";

import { WAKE_MOMENT_VERSION, type MemoryLedgerEntry, type WakeMomentRow } from "./types.js";

const text = z.string().min(1);
const instant = z.iso.datetime({ offset: true }).refine((value) => Number.isFinite(Date.parse(value)));
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const snapshot = z.object({
  id: text.regex(/^[A-Za-z0-9._-]{1,128}$/u),
  snapshot: text.regex(/^\d{8}T\d{9}Z-[A-Za-z0-9._-]{1,200}$/u),
  files: count, copied: count, linked: count, skipped: count
}).strict();
const wakeMomentSchema = z.object({
  version: z.literal(WAKE_MOMENT_VERSION), agent_id: text, execution_id: text, started_at: instant,
  deliveries: z.array(z.object({
    acceptance_id: text, delivery_id: text, kind: text, occurred_at: instant
  }).strict()).min(1),
  snapshots: z.array(snapshot).max(16).refine((values) => new Set(values.map(({ id }) => id)).size === values.length),
  error: text.max(2048).optional()
}).strict();
// Only the public cursor fields are consumed; event contents never enter a moment record.
const memoryLedgerSchema = z.object({ seq: count.positive(), createdAt: instant });

export interface RecordingJsonlRead<T> { entries: T[]; errors: string[] }
export interface RecordingJsonlParser<T> {
  write: (chunk: string) => void;
  finish: () => RecordingJsonlRead<T>;
}

const lineParser = <T>(label: string, schema: z.ZodType<T>, maxBytes?: number): RecordingJsonlParser<T> => {
  const entries: T[] = [], errors: string[] = [];
  let pending = "", lineNumber = 0, oversized = false;
  const parseLine = (line: string): void => {
    lineNumber += 1;
    try {
      if (oversized || (maxBytes !== undefined && Buffer.byteLength(line, "utf8") + 1 > maxBytes)) throw new Error("row size limit");
      entries.push(schema.parse(JSON.parse(line)));
    } catch {
      errors.push(`${label} line ${lineNumber}: invalid JSON or entry`);
    }
    oversized = false;
  };
  return {
    write(chunk) {
      const lines = chunk.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (!oversized) pending += lines[index]!;
        if (maxBytes !== undefined && Buffer.byteLength(pending, "utf8") + 1 > maxBytes) {
          oversized = true; pending = "";
        }
        if (index < lines.length - 1) { parseLine(pending); pending = ""; }
      }
    },
    finish() {
      if (pending || oversized) { parseLine(pending); pending = ""; }
      return { entries, errors };
    }
  };
};

export const createWakeMomentsParser = (): RecordingJsonlParser<WakeMomentRow> =>
  lineParser("wake moments", wakeMomentSchema, 4_194_304);
export const createMemoryLedgerParser = (): RecordingJsonlParser<MemoryLedgerEntry> =>
  lineParser("memory ledger", memoryLedgerSchema);

/** Preserve valid rows and report each malformed line, including a torn final append. */
export const parseWakeMoments = (payload: string): RecordingJsonlRead<WakeMomentRow> => {
  const parser = createWakeMomentsParser(); parser.write(payload); return parser.finish();
};

/** Missing/invalid sequence numbers are unknown history; never infer them from line order. */
export const parseMemoryLedger = (payload: string): RecordingJsonlRead<MemoryLedgerEntry> => {
  const parser = createMemoryLedgerParser(); parser.write(payload); return parser.finish();
};
