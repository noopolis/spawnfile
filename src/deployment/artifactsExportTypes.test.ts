import { describe, expect, it } from "vitest";

import { EXPORT_INDEX_VERSION, parseExportIndex } from "./artifactsExportTypes.js";

const validIndex = {
  deployment: "default",
  exported_at: "2026-07-11T00:00:00.000Z",
  files: [
    {
      bytes: 42,
      path: "raw/moltnet/causal.jsonl",
      sha256: "a".repeat(64),
      source: { kind: "volume", ref: "spawnfile-project-moltnet-causal-abc123:/causal.jsonl" }
    }
  ],
  run_id: "run-abc123",
  version: EXPORT_INDEX_VERSION
};

describe("parseExportIndex", () => {
  it("accepts a well-formed index", () => {
    expect(parseExportIndex(validIndex)).toEqual(validIndex);
  });

  it("accepts an empty files array", () => {
    expect(parseExportIndex({ ...validIndex, files: [] }).files).toEqual([]);
  });

  it("rejects a non-64-character sha256", () => {
    const invalid = { ...validIndex, files: [{ ...validIndex.files[0], sha256: "not-a-hash" }] };
    expect(() => parseExportIndex(invalid)).toThrow(/sha256/);
  });

  it("rejects an uppercase sha256", () => {
    const invalid = { ...validIndex, files: [{ ...validIndex.files[0], sha256: "A".repeat(64) }] };
    expect(() => parseExportIndex(invalid)).toThrow(/sha256/);
  });

  it("rejects an unknown source kind", () => {
    const invalid = { ...validIndex, files: [{ ...validIndex.files[0], source: { kind: "network", ref: "x" } }] };
    expect(() => parseExportIndex(invalid)).toThrow();
  });

  it("rejects a wrong version literal", () => {
    expect(() => parseExportIndex({ ...validIndex, version: "spawnfile.export-index.v2" })).toThrow();
  });

  it("rejects unknown top-level keys", () => {
    expect(() => parseExportIndex({ ...validIndex, extra: true })).toThrow();
  });

  it("requires run_id and deployment to be non-empty", () => {
    expect(() => parseExportIndex({ ...validIndex, run_id: "" })).toThrow();
    expect(() => parseExportIndex({ ...validIndex, deployment: "" })).toThrow();
  });
});
