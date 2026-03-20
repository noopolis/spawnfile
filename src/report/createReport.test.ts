import { describe, expect, it } from "vitest";

import { createCompileReport } from "./createReport.js";

describe("createCompileReport", () => {
  it("builds a v0.1 compile report", () => {
    expect(createCompileReport("/tmp/Spawnfile", [])).toEqual({
      diagnostics: [],
      nodes: [],
      root: "/tmp/Spawnfile",
      spawnfile_version: "0.1"
    });
  });
});
