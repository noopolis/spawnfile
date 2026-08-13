import { describe, expect, it } from "vitest";

import { targetResourceExportIndexSchema } from "./evidenceExportContract.js";

const digest = `sha256:${"a".repeat(64)}`;
const base = {
  evidence_digest: digest,
  export_handle: `opaque_${"b".repeat(16)}`,
  files: [],
  item_count: 0,
  labels: [],
  run_id: "run-one",
  source: {
    evidence_volume_handle: `opaque_${"c".repeat(16)}`,
    state: "preserved",
  },
  state: "exported",
  version: "spawnfile.target-resource.export-index.v1",
} as const;

describe("target evidence export index", () => {
  it("admits the exact Spawnfile activation proof path", () => {
    const marker = {
      bytes: 1,
      path: ".spawnfile/world-service-activated.v1",
      sha256: digest,
    };

    expect(targetResourceExportIndexSchema.parse({
      ...base,
      files: [marker],
      item_count: 1,
    }).files).toEqual([marker]);
  });

  it.each([
    ".spawnfile/other",
    ".hidden",
    "./spawnfile/world-service-activated.v1",
  ])("rejects non-contract hidden path %s", (path) => {
    expect(() => targetResourceExportIndexSchema.parse({
      ...base,
      files: [{ bytes: 1, path, sha256: digest }],
      item_count: 1,
    })).toThrow();
  });
});
