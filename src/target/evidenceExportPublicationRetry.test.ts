import { afterEach, describe, expect, it, vi } from "vitest";

import { publicationRetryDelayMs, waitBeforePublicationRetry } from "./evidenceExportPublicationRetry.js";

afterEach(() => { vi.useRealTimers(); });

describe("evidence export publication retry", () => {
  it("keeps the first retry free, then backs off to a bounded delay", () => {
    expect([0, 1, 2, 3, 4, 7, 8, 9, 23].map(publicationRetryDelayMs)).toEqual([0, 0, 1, 2, 4, 32, 50, 50, 50]);
  });

  it("gives a peer most of a second, not one burst of reads, across the whole attempt budget", () => {
    const total = Array.from({ length: 24 }, (_, attempt) => publicationRetryDelayMs(attempt)).reduce((sum, delay) => sum + delay, 0);
    expect(total).toBeGreaterThanOrEqual(750);
  });

  it("never waits before the first attempt and holds a later retry until its delay elapses", async () => {
    vi.useFakeTimers();
    await waitBeforePublicationRetry(0);
    await waitBeforePublicationRetry(1);
    expect(vi.getTimerCount()).toBe(0);
    let resumed = false;
    const waiting = waitBeforePublicationRetry(5).then(() => { resumed = true; });
    await vi.advanceTimersByTimeAsync(publicationRetryDelayMs(5) - 1);
    expect(resumed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(resumed).toBe(true);
  });

  it("hands the wait to an injected hook instead of the clock", async () => {
    vi.useFakeTimers();
    const attempts: number[] = [];
    const options = { beforePublicationRetry: async (attempt: number) => { attempts.push(attempt); } };
    await waitBeforePublicationRetry(0, options);
    await waitBeforePublicationRetry(7, options);
    expect(attempts).toEqual([7]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
