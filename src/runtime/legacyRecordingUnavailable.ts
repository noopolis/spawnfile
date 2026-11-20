import { z } from "zod";
import type { History } from "../compiler/training/rewind/history.js";
import type { RecordingJsonlParser, RecordingJsonlRead } from "../recording/jsonl.js";
import type { WakeMomentRow } from "../recording/types.js";
import type { RuntimeRecordingReader } from "./operations.js";

/** The shape used by rewind when a registered adapter supplies the native codec. */
export interface SnapshotManifest {
  started_at: string;
  entries: Record<string, { type: "file" | "directory" | "symlink"; mode: number; size: string; target?: string }>;
}

const unavailable = "The legacy recording adapter is unavailable in this build";
const refuse = (): never => { throw new Error(unavailable); };

export const createWakeMomentsParser: () => RecordingJsonlParser<WakeMomentRow> = refuse;
export const parseWakeMoments: (payload: string) => RecordingJsonlRead<WakeMomentRow> = refuse;
export const readRecordingJsonl: RuntimeRecordingReader["readJsonl"] = async () => ({
  entries: [], errors: [], failure: unavailable
});

export const snapshotManifestSchema = z.custom<SnapshotManifest>(() => false, unavailable);
export const readSnapshotManifest: (
  history: Pick<History, "bytes" | "text">, relative: string, id: string, snapshot: string
) => Promise<SnapshotManifest | null> = async () => refuse();
export const snapshotHistoryPath: (agentSlug: string, id: string, snapshot: string) => string = refuse;
export const wakeHistoryPath: (agentSlug: string) => string = refuse;
export const isPartialSnapshot: (snapshot: string) => boolean = refuse;
export const retainedSnapshotMode: (
  type: "file" | "directory" | "symlink", mode: number
) => number | null = refuse;
