import { SpawnfileError } from "../shared/index.js";

import type { ResolvedTeamNode } from "./types.js";
import { createShortHash, slugify } from "./helpers.js";

const ROOTFS_PREFIX = "container/rootfs";
const ARTIFACT_SEGMENT = /^[a-z][a-z0-9-]{0,62}$/u;

export const createMoltnetExternalParticipantArtifactPath = (networkId: string, memberId: string): string => {
  if (
    !ARTIFACT_SEGMENT.test(networkId) ||
    !/^[a-z][a-z0-9-]{0,62}(?:\.[a-z][a-z0-9-]{0,62}){0,7}$/u.test(memberId) ||
    Buffer.byteLength(memberId, "ascii") > 255
  ) {
    throw new SpawnfileError(
      "validation_error",
      "invalid Moltnet external participant artifact path segment"
    );
  }
  return `moltnet/external-participants/${networkId}/${memberId}.json`;
};

const truncateSegment = (value: string, maxLength: number): string =>
  value.length > maxLength ? value.slice(0, maxLength).replace(/[-_.]+$/u, "") : value;

/**
 * Derives the host-mounted docker volume name for a **run-scoped** durable
 * mount — state whose whole point is to be fresh per run (today: the Moltnet
 * causal event log, Daimon telemetry, per-network Moltnet runtime state).
 *
 * `runId` (the compiling process's resolved NOOPOLIS_RUN_ID, see
 * src/runtime/common.ts) is the run-scoping key: `spawnfile run`/`spawnfile
 * up` always call `ensureNoopolisRunId()` before compiling, so a fresh
 * invocation with no host-pinned run id gets a fresh generated one and
 * therefore a fresh volume — two concurrent/successive runs (e.g. two
 * memetics replicates) never share it. A cold restart that wants the same
 * run's state sets the SAME `NOOPOLIS_RUN_ID` before re-running, which
 * reproduces this name and remounts it. Omitted (a bare `spawnfile
 * compile`/`spawnfile build` with no run id in the host env) reproduces the
 * pre-run-scoping name exactly, so standard compiles stay byte-identical.
 *
 * State that must SURVIVE a redeploy — workspace `kind: volume` resources,
 * durable Moltnet stores, open-mode agent token directories, durable memory
 * banks, the Daimon usage ledger — must NEVER be named here. Those are
 * `lifecycle: "exclusive-reattach"` and are named by
 * `createExclusiveReattachVolumeName` from the plan root and the deployment
 * lineage, honouring an author-declared name verbatim. This function
 * deliberately takes no author-declared name: a run-scoped volume is never
 * the thing an author names.
 */
export const createPersistentVolumeName = (
  planRoot: string,
  id: string,
  runId?: string
): string => {
  const project = truncateSegment(slugify(planRoot.split("/").slice(-2, -1)[0] ?? "project") || "project", 32);
  const suffix = truncateSegment(slugify(id) || "state", 48);
  const trimmedRunId = runId?.trim();
  if (!trimmedRunId) {
    return `spawnfile-${project}-${suffix}-${createShortHash(`${planRoot}:${id}`)}`;
  }

  const runSegment = truncateSegment(slugify(trimmedRunId) || "run", 24);
  return `spawnfile-${project}-${suffix}-${runSegment}-${createShortHash(`${planRoot}:${id}:${trimmedRunId}`)}`;
};

export const toContainerRootfsPath = (rootfsPath: string): string =>
  `/${rootfsPath.replace(`${ROOTFS_PREFIX}/`, "")}`;

export const isNetworkHttpEnabled = (
  network: NonNullable<ResolvedTeamNode["networks"]>[number]
): boolean => network.server?.mode === "managed" && network.server.human_ingress === true;

export const resolveNetworkPort = (
  network: NonNullable<ResolvedTeamNode["networks"]>[number],
  fallbackPort: number
): number =>
  network.server?.mode === "managed" ? network.server.listen.port : fallbackPort;
