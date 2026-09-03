import { SpawnfileError } from "../shared/index.js";

import type { ContainerPersistentMountReport } from "../report/types.js";

/**
 * Lineage namespace for `spawnfile dev up`.
 *
 * A derived `exclusive-reattach` volume name folds in the deployment lineage,
 * and `dev up` used to delegate straight to `up` with no distinguishing
 * identity — so both defaulted to the lineage `default` and resolved to the
 * SAME host volumes. A dev deployment started while production was stopped
 * therefore attached production's volumes and wrote into live state. That is
 * strictly worse than the loss this branch set out to fix: loss is recoverable
 * from a backup, a dev agent editing production's message store is not.
 *
 * The namespace applies to the lineage only, never to the deployment name, so
 * deployment records, labels, and `spawnfile dev stop --deployment <name>` are
 * unchanged. It also applies regardless of `--deployment`, so `dev up
 * --deployment blue` and `up --deployment blue` still cannot collide.
 */
export const DEV_DEPLOYMENT_LINEAGE_NAMESPACE = "dev";

/**
 * Combines a lineage namespace with a deployment name. The result is only ever
 * a hash input (`createExclusiveReattachVolumeName`), so any injective
 * encoding works; `\0` cannot occur in a deployment name and therefore cannot
 * be used to forge a collision with a production lineage.
 */
export const resolveDeploymentLineage = (
  deploymentName: string,
  namespace?: string
): string => namespace ? `${namespace}\0${deploymentName}` : deploymentName;

/**
 * An author-declared volume name carries no lineage — that is the point of
 * declaring it, and it is what lets an operator pre-create or migrate the
 * volume. It also means the namespace above cannot protect a declared volume:
 * `dev up` would attach production's `clank-newsroom-store` by that exact name.
 *
 * "I declared a stable host volume name" and "this is a throwaway dev
 * deployment" are contradictory intentions, and the branch's established
 * posture for that situation is to fail closed with a named, explicit
 * override rather than to warn into a scrolling log. So `dev up` refuses,
 * listing the exact volumes it would have attached, and `--allow-declared-volumes`
 * is how an operator says they meant it (a scratch clone of the project, or a
 * deliberate read of real state).
 */
export const assertNoDeclaredVolumeNames = (
  mounts: readonly ContainerPersistentMountReport[]
): void => {
  const declared = [...new Set(mounts.flatMap((mount) =>
    mount.declared_volume_name ? [mount.declared_volume_name] : []
  ))].sort();
  if (declared.length === 0) return;
  throw new SpawnfileError(
    "validation_error",
    `This dev deployment would attach ${declared.length} author-declared volume`
    + `${declared.length === 1 ? "" : "s"} by name, which a production deployment of `
    + `this project uses too: ${declared.join(", ")}. A declared name carries no `
    + "deployment identity, so dev would write into that live state. Remove the "
    + "declared name, run dev against a copy of the project, or pass "
    + "--allow-declared-volumes to attach them deliberately."
  );
};
