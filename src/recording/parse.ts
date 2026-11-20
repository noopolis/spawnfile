import { z } from "zod";
import { compatibleIsoDateTimeSchema } from "../shared/index.js";
import { createRecordingJsonlParser, type RecordingJsonlRead } from "./jsonl.js";
import type { MemoryLedgerEntry } from "./types.js";

export { createWakeMomentsParser, parseWakeMoments } from "../runtime/legacyRecording.generated.js";
export type { RecordingJsonlParser, RecordingJsonlRead } from "./jsonl.js";

// Only the public cursor fields are consumed. Event payloads stay in the ledger.
const memoryLedgerSchema = z.object({
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdAt: compatibleIsoDateTimeSchema({ offset: true }).refine((value) => Number.isFinite(Date.parse(value)))
});

export const createMemoryLedgerParser = () => createRecordingJsonlParser("memory ledger", memoryLedgerSchema);

/** Missing or invalid sequence numbers are unknown history. */
export const parseMemoryLedger = (payload: string): RecordingJsonlRead<MemoryLedgerEntry> => {
  const parser = createMemoryLedgerParser();
  parser.write(payload);
  return parser.finish();
};
