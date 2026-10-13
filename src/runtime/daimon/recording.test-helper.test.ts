import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { daimonSupportsWakeMoments, readVerifiedDaimonContractManifest } from "./contractManifest.js";
import { capableDaimonManifest } from "./recording.test-helper.js";
import { DAIMON_WAKE_MOMENTS } from "./wakeMoments.js";

describe("recording manifest fixture", () => {
  it("uses the verified packaged capability without duplicating consumed fields", async () => {
    const manifest = capableDaimonManifest();
    const packaged = await readVerifiedDaimonContractManifest(fileURLToPath(new URL(".", import.meta.url)));
    expect(manifest).toEqual(packaged.manifest);
    expect(daimonSupportsWakeMoments(manifest)).toBe(true);
    expect(manifest.consumedConfigFields.filter((field) => field === DAIMON_WAKE_MOMENTS.configField))
      .toEqual([DAIMON_WAKE_MOMENTS.configField]);
  });
});
