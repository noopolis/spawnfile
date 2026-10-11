import { describe, expect, it } from "vitest";

import { assertRecordedMemoryRetention, recordedMemoryForDeletion } from "./recordedMemoryRetention.js";

describe("assertRecordedMemoryRetention", () => {
  const recording = { keep_ms: 1, memory_mount_ids: ["memory-one"] };
  const mounts = [{ id: "memory-one", name: "shared" }, { id: "workspace", name: "shared" }];
  const nameOf = (mount: typeof mounts[number]) => mount.name;

  it("protects an aliased memory name when deletion selected a different mount id", () => {
    expect(() => assertRecordedMemoryRetention(recording, mounts, [nameOf(mounts[1]!)], nameOf,
      { removeVolumes: true })).toThrow("Recording retains memory ledgers and recording stores in shared");
  });

  it("permits deletion when no recording agent can access the selected memory", () => {
    expect(() => assertRecordedMemoryRetention(recording, mounts, ["unrecorded"], nameOf,
      { removeVolumes: true })).not.toThrow();
  });

  it("protects recording stores even without memory and only the explicit override permits deletion", () => {
    const stores = { keep_ms: 1, memory_mount_ids: [], recording_mount_ids: ["recording-writer"] };
    const mounts = [{ id: "recording-writer", name: "snapshots" }, { id: "alias", name: "snapshots" }];
    expect(() => assertRecordedMemoryRetention(stores, mounts, ["snapshots"], nameOf, { removeVolumes: true }))
      .toThrow("recording stores");
    expect(() => assertRecordedMemoryRetention(stores, mounts, ["snapshots"], nameOf,
      { removeVolumes: true, discardRecordedMemory: true })).not.toThrow();
  });

  it("refuses a cached report that drops deployed recording-store protection", () => {
    const deployed = { keep_ms: 1, memory_mount_ids: [], recording_mount_ids: ["recording-writer"] };
    const record = { recording: deployed, compile_fingerprint: "same" };
    expect(() => recordedMemoryForDeletion(record, { compile_fingerprint: "same", recording: { keep_ms: 1, memory_mount_ids: [] } },
      [{ id: "recording-writer" }], { removeVolumes: true })).toThrow("cannot be weakened");
  });
});
