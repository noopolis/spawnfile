import path from "node:path";

// The public plan barrel also loads buildCompilePlan -> runtime registry. Keep
// the adapter on its pure resolver to avoid cycling through its own registration.
import { resolveTrainingRecordVolumes } from "../../compiler/training/plan/references.js";
import { toWorkspaceResourcePlan, workspaceResourceTargetId } from "../../compiler/workspaceResources.js";
import type { ResolvedAgentNode } from "../../compiler/types.js";
import { recordingKeepMs, SpawnfileError } from "../../shared/index.js";
import type { ContainerTargetInput } from "../types.js";
import { DAIMON_WAKE_MOMENTS } from "./wakeMoments.js";

export interface DaimonAgentRecording {
  directory: string;
  keepMs: number;
  snapshots: Array<{ id: string; path: string }>;
}

export const daimonRecordingDirectory = (slug: string): string => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) {
    throw new SpawnfileError("validation_error", `Daimon recording requires a nonempty safe agent slug: ${slug}`);
  }
  return `/var/lib/spawnfile/recording/${slug}`;
};
export const DAIMON_RECORDING_MOUNT_ID_PREFIX = "daimon-recording-";
export const daimonRecordingMountId = (slug: string): string => `${DAIMON_RECORDING_MOUNT_ID_PREFIX}${slug}`;

/** Snapshot paths share the container resource placement authority, never workspace links. */
export const resolveDaimonAgentRecording = (
  input: ContainerTargetInput & { value: ResolvedAgentNode }, targetId: string, agentCount: number
): DaimonAgentRecording | undefined => {
  const keepMs = recordingKeepMs(input.value.training?.record);
  if (keepMs === undefined) return undefined;
  const snapshots = resolveTrainingRecordVolumes(input).map((resource) => ({
    id: resource.id,
    path: toWorkspaceResourcePlan(resource, {
      targetId: workspaceResourceTargetId(targetId, input.id, agentCount),
      workspacePath: `<workspace-path>/agents/${input.slug}`
    }).backingPath
  }));
  if (snapshots.length > DAIMON_WAKE_MOMENTS.maxSnapshotRoots) {
    throw new SpawnfileError("validation_error", `Daimon recording for ${input.id} supports at most ${DAIMON_WAKE_MOMENTS.maxSnapshotRoots} snapshot roots`);
  }
  for (const snapshot of snapshots) {
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(snapshot.id) || snapshot.path.length > 4096) {
      throw new SpawnfileError("validation_error", `Daimon recording snapshot ${snapshot.id} for ${input.id} exceeds the runtime id or path bounds`);
    }
  }
  return { directory: daimonRecordingDirectory(input.slug), keepMs, snapshots };
};

const overlaps = (left: string, right: string): boolean =>
  left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);

/** Generated workspaces/homes live under instances; sources under resources; stores must remain separate. */
export const assertDaimonRecordingIsolation = (
  recordings: Array<DaimonAgentRecording | undefined>, instanceRoot: string
): void => {
  for (const [index, recording] of recordings.entries()) {
    if (!recording) continue;
    const conflicting = [instanceRoot, ...recordings.flatMap((peer, peerIndex) => peer
      ? [...(peerIndex === index ? [] : [peer.directory]), ...peer.snapshots.map((snapshot) => snapshot.path)] : [])];
    if (recording.directory.length > 4096 || conflicting.some((root) => overlaps(path.posix.normalize(root), recording.directory))) {
      throw new SpawnfileError("validation_error", `Daimon recording store ${recording.directory} overlaps a runtime or snapshot root or another recording store`);
    }
  }
};
