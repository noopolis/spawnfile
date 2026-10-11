import { expect, it, vi } from "vitest";
import { activationBeforeStart } from "./activation.js";

it("waits until the shared host clock is strictly later than the old stopped observation", async () => {
  const stopped = Date.parse("2026-10-10T10:00:00.123Z");
  const clock = vi.fn().mockReturnValueOnce(new Date(stopped)).mockReturnValueOnce(new Date(stopped))
    .mockReturnValue(new Date(stopped + 1));
  expect(await activationBeforeStart(stopped, clock)).toEqual({ activated_at: "2026-10-10T10:00:00.124Z", activation_exact: true });
  expect(clock).toHaveBeenCalledTimes(3);
});

it("captures a first launch without waiting for a nonexistent predecessor", async () => {
  const clock = vi.fn(() => new Date("2026-10-10T10:00:00.123Z"));
  expect(await activationBeforeStart(undefined, clock)).toEqual({ activated_at: "2026-10-10T10:00:00.123Z", activation_exact: true });
  expect(clock).toHaveBeenCalledOnce();
});
