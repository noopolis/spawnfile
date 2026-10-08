import { readFile, rm } from "node:fs/promises";

import { z } from "zod";

import { writeJsonAtomic } from "./ledger.js";

export const RELEASE_PENDING_VERSION = "spawnfile.release-pending.v1" as const;

const pendingSchema = z.object({
  identity: z.string().min(1),
  notified_at: z.string().min(1).nullable(),
  since: z.string().min(1),
  version: z.literal(RELEASE_PENDING_VERSION)
}).strict();

export type ReleasePending = z.infer<typeof pendingSchema>;

export interface DeferralDecision {
  ageMs: number;
  /** True exactly once per pending identity after the threshold, or whenever tracking is broken. */
  notify: boolean;
  pending: ReleasePending;
  /** Set when the record that holds "waiting since" could not be read or written. */
  trackingBroken: string | null;
}

/**
 * A drain that times out is "not yet", not "broken": on a timer that runs
 * hourly, notifying on every busy hour teaches whoever receives it to ignore
 * the channel. It must not hide forever either, so the instant this identity
 * first deferred is kept beside the ledger and a person hears about it once
 * it has waited longer than `notifyAfterMs`.
 *
 * The record is the only thing that turns "forever" into one notification,
 * so a record that cannot be read or written is itself notified immediately,
 * never silently restarted.
 */
export const recordDeferral = async (
  file: string,
  identity: string,
  options: { notifyAfterMs: number; now?: Date }
): Promise<DeferralDecision> => {
  const now = options.now ?? new Date();
  let previous: ReleasePending | null = null;
  let trackingBroken: string | null = null;
  try {
    previous = pendingSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      trackingBroken = `the pending-release record ${file} cannot be read`;
    }
  }
  const pending: ReleasePending = previous?.identity === identity
    ? { ...previous }
    : { identity, notified_at: null, since: now.toISOString(), version: RELEASE_PENDING_VERSION };
  const since = Date.parse(pending.since);
  const ageMs = Number.isFinite(since) ? Math.max(0, now.getTime() - since) : 0;
  // `notified_at` is set only once a notification was actually delivered
  // (markDeferralNotified), so a failed or crashed delivery is retried next run.
  const escalate = ageMs >= options.notifyAfterMs && pending.notified_at === null;
  try {
    await writeJsonAtomic(file, pending);
  } catch {
    trackingBroken = `the pending-release record ${file} could not be written`;
  }
  return { ageMs, notify: escalate || trackingBroken !== null, pending, trackingBroken };
};

export const markDeferralNotified = async (file: string, pending: ReleasePending, now: Date = new Date()): Promise<void> => {
  await writeJsonAtomic(file, { ...pending, notified_at: now.toISOString() });
};

export const clearDeferral = async (file: string): Promise<void> => {
  await rm(file, { force: true });
};
