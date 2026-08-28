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
 * Derives the host-mounted docker volume name for a durable mount.
 *
 * `runId` (the compiling process's resolved NOOPOLIS_RUN_ID, see
 * src/runtime/common.ts) is the run-scoping key: `spawnfile run`/`spawnfile
 * up` always call `ensureNoopolisRunId()` before compiling, so a fresh
 * invocation with no host-pinned run id gets a fresh generated one and
 * therefore a fresh volume — two concurrent/successive runs (e.g. two
 * memetics replicates) never share durable state. A cold restart that wants
 * to recall the same run's memory sets the SAME `NOOPOLIS_RUN_ID` before
 * re-running, which reproduces this same volume name and remounts it.
 * Omitted (a bare `spawnfile compile`/`spawnfile build` with no run id in
 * the host env) reproduces the pre-run-scoping name exactly, so standard
 * compiles stay byte-identical.
 *
 * `explicitName` (an author-declared `persistence.name`) remains verbatim for
 * a bare compile. During a run it is namespaced by the run identity, preventing
 * blue/green candidates from accidentally sharing live durable state.
 */
export const createPersistentVolumeName = (
  planRoot: string,
  id: string,
  explicitName?: string,
  runId?: string
): string => {
  const project = truncateSegment(slugify(planRoot.split("/").slice(-2, -1)[0] ?? "project") || "project", 32);
  const suffix = truncateSegment(slugify(explicitName?.trim() || id) || "state", 48);
  const trimmedRunId = runId?.trim();
  if (explicitName && explicitName.trim().length > 0 && !trimmedRunId) return explicitName.trim();
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
