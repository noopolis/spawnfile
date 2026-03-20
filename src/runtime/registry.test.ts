import { describe, expect, it } from "vitest";

import { getRuntimeAdapter, listRuntimeAdapters } from "./registry.js";

describe("runtime registry", () => {
  it("lists available runtime adapters", () => {
    expect(listRuntimeAdapters()).toEqual(["openclaw", "picoclaw", "tinyclaw"]);
  });

  it("returns a runtime adapter by name", () => {
    expect(getRuntimeAdapter("openclaw").name).toBe("openclaw");
  });

  it("throws on unknown runtime adapters", () => {
    expect(() => getRuntimeAdapter("unknown")).toThrowError(/Unknown runtime adapter/);
  });
});
