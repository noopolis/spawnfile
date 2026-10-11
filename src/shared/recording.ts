import { SpawnfileError } from "./errors.js";

export const DEFAULT_RECORD_KEEP_MS = 30 * 24 * 60 * 60_000;

/** Absence disables recording; an empty declaration opts into the default window. */
export const recordingKeepMs = (record: { keep?: string } | undefined): number | undefined => {
  if (record === undefined) return undefined;
  if (record.keep === undefined) return DEFAULT_RECORD_KEEP_MS;
  const match = /^([1-9][0-9]*)([mhd])$/u.exec(record.keep);
  const factors: Record<string, number> = { m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 };
  const milliseconds = match ? Number(match[1]) * factors[match[2]!]! : NaN;
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new SpawnfileError("validation_error", "record.keep must be a safe positive duration matching ^[1-9][0-9]*[mhd]$");
  }
  return milliseconds;
};

export const maxRecordingKeepMs = (records: Iterable<{ keep?: string } | undefined>): number | undefined => {
  let maximum: number | undefined;
  for (const record of records) {
    const keep = recordingKeepMs(record);
    if (keep !== undefined) maximum = Math.max(maximum ?? 0, keep);
  }
  return maximum;
};
