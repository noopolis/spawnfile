import { describe, expect, it } from "vitest";

import { SpawnfileError, errorExitCode, isSpawnfileError } from "./errors.js";

describe("shared errors", () => {
  it("recognizes SpawnfileError values", () => {
    expect(isSpawnfileError(new SpawnfileError("validation_error", "boom"))).toBe(true);
  });

  it("recognizes an older copy with the original Error subclass identity", () => {
    const LegacyError = class SpawnfileError extends Error {
      constructor(readonly code: string, message: string) {
        super(message);
        this.name = "SpawnfileError";
      }
    };

    expect(new LegacyError("validation_error", "bad input")).not.toBeInstanceOf(SpawnfileError);
    expect(errorExitCode(new LegacyError("validation_error", "bad input"))).toBe(2);
    expect(errorExitCode(new LegacyError("runtime_error", "failed operation"))).toBe(1);
    expect(isSpawnfileError(new LegacyError("unknown_code", "bad input"))).toBe(false);
  });

  it("rejects generic objects and errors with a matching code", () => {
    expect(isSpawnfileError(new Error("boom"))).toBe(false);
    const fields = { name: "SpawnfileError", code: "validation_error" };
    expect(errorExitCode(fields)).toBe(1);
    expect(errorExitCode(Object.assign(new Error("boom"), fields))).toBe(1);
  });
});
