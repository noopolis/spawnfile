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

const parseLines = <T>(payload: string, label: string, schema: z.ZodType<T>, maxBytes?: number): RecordingJsonlRead<T> => {
  if (payload === "") return { entries: [], errors: [] };
  const lines = payload.split("\n"), entries: T[] = [], errors: string[] = [];
  if (lines.at(-1) === "") lines.pop();
  lines.forEach((line, index) => {
    try {
      if (maxBytes !== undefined && Buffer.byteLength(line, "utf8") + 1 > maxBytes) throw new Error("row size limit");
      entries.push(schema.parse(JSON.parse(line)));
    } catch {
      errors.push(`${label} line ${index + 1}: invalid JSON or entry`);
    }
  });
  return { entries, errors };
};

/** Preserve valid rows and report each malformed line, including a torn final append. */
export const parseWakeMoments = (payload: string): RecordingJsonlRead<WakeMomentRow> =>
  parseLines(payload, "wake moments", wakeMomentSchema, 4_194_304);

/** Missing/invalid sequence numbers are unknown history; never infer them from line order. */
export const parseMemoryLedger = (payload: string): RecordingJsonlRead<MemoryLedgerEntry> =>
  parseLines(payload, "memory ledger", memoryLedgerSchema);
