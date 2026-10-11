import { describe, expect, it } from "vitest";

import { assertRecordedMemoryRetention } from "./recordedMemoryRetention.js";

describe("assertRecordedMemoryRetention", () => {
  const recording = { keep_ms: 1, memory_mount_ids: ["memory-one"] };
  const mounts = [{ id: "memory-one", name: "shared" }, { id: "workspace", name: "shared" }];
  const nameOf = (mount: typeof mounts[number]) => mount.name;

  it("protects an aliased memory name when deletion selected a different mount id", () => {
    expect(() => assertRecordedMemoryRetention(recording, mounts, [nameOf(mounts[1]!)], nameOf,
      { removeVolumes: true })).toThrow("Recording retains memory ledgers in shared");
  });

  it("permits deletion when no recording agent can access the selected memory", () => {
    expect(() => assertRecordedMemoryRetention(recording, mounts, ["unrecorded"], nameOf,
      { removeVolumes: true })).not.toThrow();
  });
});
