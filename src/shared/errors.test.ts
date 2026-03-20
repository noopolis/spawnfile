import { describe, expect, it } from "vitest";

import { SpawnfileError, isSpawnfileError } from "./errors.js";

describe("shared errors", () => {
  it("recognizes SpawnfileError values", () => {
    expect(isSpawnfileError(new SpawnfileError("validation_error", "boom"))).toBe(true);
  });

  it("rejects non-SpawnfileError values", () => {
    expect(isSpawnfileError(new Error("boom"))).toBe(false);
  });
});
