import { describe, expect, it } from "vitest";

import {
  assertPersistentMountVolumeNamesAreUnique,
  mergePersistentMounts
} from "./containerPersistentMounts.js";

const mount = (id: string, mountPath: string, volumeName: string) => ({
  id,
  lifecycle: "exclusive-reattach" as const,
  mount_path: mountPath,
  reason: `reason for ${id}`,
  volume_name: volumeName
});

describe("assertPersistentMountVolumeNamesAreUnique", () => {
  it("rejects one declared name claimed by two different mount paths", () => {
    // The cross-kind case: a workspace resource `name: X` and a managed
    // Moltnet store `persistence.name: X` compile to two mounts at two paths
    // carrying one volume name, so docker mounts one host volume at both and
    // their bootstrap-marker/sentinel protocols contradict each other.
    expect(() => assertPersistentMountVolumeNamesAreUnique([
      mount("moltnet-newsroom-store", "/var/lib/spawnfile/moltnet/networks/newsroom", "clank-dup"),
      mount("workspace-resource-abc", "/var/lib/spawnfile/resources/teams/t/clank-dup-1", "clank-dup")
    ])).toThrow(/claimed by two different mounts/u);
  });

  it("names both colliding declarations so an author can find them", () => {
    let message = "";
    try {
      assertPersistentMountVolumeNamesAreUnique([
        mount("moltnet-newsroom-store", "/store", "clank-dup"),
        mount("workspace-resource-abc", "/resource", "clank-dup")
      ]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("moltnet-newsroom-store");
    expect(message).toContain("reason for moltnet-newsroom-store");
    expect(message).toContain("/store");
    expect(message).toContain("workspace-resource-abc");
    expect(message).toContain("/resource");
  });

  it("accepts the same mount listed twice by two sources", () => {
    expect(() => assertPersistentMountVolumeNamesAreUnique([
      mount("memory-bank", "/var/lib/spawnfile/memory/bank", "clank-bank"),
      mount("memory-bank", "/var/lib/spawnfile/memory/bank", "clank-bank")
    ])).not.toThrow();
  });

  it("accepts distinct names across every mount source", () => {
    expect(() => assertPersistentMountVolumeNamesAreUnique([
      mount("moltnet-newsroom-store", "/store", "clank-newsroom-store"),
      mount("workspace-resource-abc", "/resource", "clank-edition-state"),
      mount("memory-bank", "/memory", "clank-memory")
    ])).not.toThrow();
  });
});

describe("mergePersistentMounts", () => {
  it("orders by id and rejects one id described differently by two sources", () => {
    expect(mergePersistentMounts([
      mount("b", "/b", "vb"),
      mount("a", "/a", "va")
    ]).map((entry) => entry.id)).toEqual(["a", "b"]);

    expect(() => mergePersistentMounts([
      mount("store", "/one", "v"),
      { ...mount("store", "/two", "v2") }
    ])).toThrow(/resolves to conflicting targets/u);
  });

  it("still rejects two ids claiming one host volume name", () => {
    expect(() => mergePersistentMounts([
      mount("moltnet-store", "/store", "clank-dup"),
      mount("workspace-resource-abc", "/resource", "clank-dup")
    ])).toThrow(/claimed by two different mounts/u);
  });
});
