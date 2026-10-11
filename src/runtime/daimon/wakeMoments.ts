/** Exact data-only wake recording contract advertised by Daimon's image receipt. */
export const DAIMON_WAKE_MOMENTS = {
  version: "noopolis.daimon.wake-moment.v1",
  rowsFile: "wake-moments.jsonl",
  snapshotsDirectory: "snapshots",
  completionSuffix: ".complete",
  maxSnapshotRoots: 16,
  maxSnapshotEntries: 200_000,
  maxRowBytes: 4_194_304,
  maxManifestBytes: 134_217_728,
  captureDeadlineMs: 60_000,
  finalizationDeadlineMs: 1_000,
  configField: "agents[].recording"
} as const;

export const isDaimonWakeMoments = (value: unknown): value is typeof DAIMON_WAKE_MOMENTS =>
  value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === Object.keys(DAIMON_WAKE_MOMENTS).length
  && Object.entries(DAIMON_WAKE_MOMENTS).every(([key, expected]) =>
    Object.hasOwn(value, key) && (value as Record<string, unknown>)[key] === expected);
