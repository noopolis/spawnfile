import { SpawnfileError } from "../shared/index.js";

import type { ContainerPersistentMountReport } from "../report/types.js";

/**
 * Durable mount names come from four independent sources — memory banks
 * (`memoryArtifacts.ts`), workspace `kind: volume` resources
 * (`containerTargetResources.ts`), Moltnet stores and token directories
 * (`moltnetArtifacts.ts`), and runtime-declared mounts (`runtimePlans`) —
 * and each source only ever checked itself.
 *
 * Author-declared names cross those boundaries. A resource with
 * `name: X` and a managed Moltnet store with `persistence.name: X` used to
 * compile to two mounts at two different paths carrying one `volume_name`, so
 * `spawnfile run` mounted a single host volume at both. A sqlite store and a
 * team's edition state then shared one directory, where their bootstrap-marker
 * and replacement-sentinel protocols contradict each other.
 *
 * There is no safe interpretation of that declaration, so it fails at compile
 * naming both sides. (Two mounts legitimately SHARE a name only when they are
 * the same mount, which the id-keyed merge upstream has already collapsed.)
 */
export const assertPersistentMountVolumeNamesAreUnique = (
  mounts: readonly ContainerPersistentMountReport[]
): void => {
  const byVolumeName = new Map<string, ContainerPersistentMountReport>();
  for (const mount of mounts) {
    const existing = byVolumeName.get(mount.volume_name);
    if (existing && existing.mount_path !== mount.mount_path) {
      throw new SpawnfileError(
        "validation_error",
        `Durable volume name "${mount.volume_name}" is claimed by two different mounts: `
        + `${existing.id} (${existing.reason}) at ${existing.mount_path}, and `
        + `${mount.id} (${mount.reason}) at ${mount.mount_path}. `
        + "One host volume cannot back two container paths; give each declaration its own name."
      );
    }
    if (!existing) byVolumeName.set(mount.volume_name, mount);
  }
};
