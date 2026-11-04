import { expect, it } from "vitest";

import type { DaimonContractManifest } from "./contractManifest.js";
import { assertDaimonWakeTextBound, resolveDaimonWakeTextBytes } from "./wakeTextBound.js";

it("admits a wider wake text bound only when the pinned Daimon declares one that fits", async () => {
  expect(resolveDaimonWakeTextBytes(undefined)).toBeUndefined();
  expect(resolveDaimonWakeTextBytes(196_608)).toBe(196_608);
  for (const invalid of [16_383, 1.5, "big"]) expect(() => resolveDaimonWakeTextBytes(invalid, "judge")).toThrow(/max_wake_text_bytes.*judge/u);
  const manifest = (ceiling?: number) => ({ ...(ceiling === undefined ? {} : { maxWakeTextBytesCeiling: ceiling }) }) as DaimonContractManifest;
  await expect(assertDaimonWakeTextBound(196_608, manifest(262_144))).resolves.toBeUndefined();
  await expect(assertDaimonWakeTextBound(196_608, manifest())).rejects.toThrow(/does not declare host.maxWakeTextBytes/u);
  await expect(assertDaimonWakeTextBound(300_000, manifest(262_144))).rejects.toThrow(/exceeds the pinned Daimon ceiling/u);
});
