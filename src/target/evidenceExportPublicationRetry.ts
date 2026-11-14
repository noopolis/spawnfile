import type { EvidenceExportPublicationOptions } from "./evidenceExportPublicationTypes.js";

const MAX_RETRY_DELAY_MS = 50;

/**
 * How long a publication loop waits before retry `attempt`. A retry means another process is between
 * two of its own durable steps (a link, a directory sync, an unlink), so re-reading at once only burns
 * the attempt budget faster than that peer can finish one fsync. The first retry is free because the
 * uncontended path always needs it to observe its own cleanup.
 */
export const publicationRetryDelayMs = (attempt: number): number =>
  attempt < 2 ? 0 : Math.min(2 ** (attempt - 2), MAX_RETRY_DELAY_MS);

/** Runs at the top of every publication attempt; attempt 0 is the first try and never waits. */
export const waitBeforePublicationRetry = async (attempt: number, options?: EvidenceExportPublicationOptions): Promise<void> => {
  if (attempt === 0) return;
  if (options?.beforePublicationRetry) { await options.beforePublicationRetry(attempt); return; }
  const delay = publicationRetryDelayMs(attempt);
  if (delay > 0) await new Promise<void>((resolve) => { setTimeout(resolve, delay); });
};
