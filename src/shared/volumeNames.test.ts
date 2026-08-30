import { describe, expect, it } from "vitest";

import { createExclusiveReattachVolumeName } from "./volumeNames.js";

describe("exclusive reattach volume names", () => {
  it("uses a stable generic label when the compiler-owned mount id normalizes empty", () => {
    expect(createExclusiveReattachVolumeName("deployment-a", "///"))
      .toMatch(/^spawnfile-exclusive-realm-[a-f0-9]{16}$/u);
  });
});
