import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { SpawnfileError } from "../shared/index.js";

import { derivePersistentMountVolumeName } from "./consumeImageSupport.js";
import type { DockerCommandRunner } from "./dockerRunner.js";
import type { DistributionReport } from "./types.js";

interface ContainerState {
  Health?: { Status?: string };
  Running?: boolean;
  Status?: string;
}

export interface ContainerSnapshot {
  readonly id: string;
  readonly name: string;
  readonly running: boolean;
}

export interface ExclusiveVolumeReservation {
  release(): Promise<void>;
}

interface ReservationRecord {
  readonly id: string;
  readonly name: string;
  readonly owner: string;
  readonly volumeDigest: string;
}

const dockerId = /^[a-f0-9]{64}$/u;
const missingContainer = /(?:No such (?:container|object)|container .* not found)/iu;
const snapshotFormat = "{{json .Id}}\n{{json .Name}}\n{{json .State.Running}}";
const reservationFormat = "{{json .Id}}\n{{json .Config.Labels}}";
const reservationVersionLabel = "com.spawnfile.exclusive-volume-reservation";
const reservationOwnerLabel = "com.spawnfile.exclusive-volume-owner";
const reservationVolumeLabel = "com.spawnfile.exclusive-volume-digest";

const parseSnapshot = (raw: Buffer): ContainerSnapshot => {
  try {
    const [idRaw, nameRaw, runningRaw, ...extra] = raw.toString("utf8").trim().split("\n");
    if (!idRaw || !nameRaw || !runningRaw || extra.length > 0) throw new Error("shape");
    const id = JSON.parse(idRaw) as unknown;
    const name = JSON.parse(nameRaw) as unknown;
    const running = JSON.parse(runningRaw) as unknown;
    if (typeof id !== "string" || !dockerId.test(id)
      || typeof name !== "string" || !name.startsWith("/") || name.length < 2
      || typeof running !== "boolean") throw new Error("values");
    return { id, name: name.slice(1), running };
  } catch {
    throw new SpawnfileError("runtime_error", "Container returned invalid identity state");
  }
};

export const inspectContainerSnapshot = async (
  runDocker: DockerCommandRunner,
  reference: string
): Promise<ContainerSnapshot | null> => {
  try {
    return parseSnapshot(await runDocker([
      "container", "inspect", "--format", snapshotFormat, reference
    ]));
  } catch (error) {
    if (error instanceof SpawnfileError && error.message === "Container returned invalid identity state") throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (missingContainer.test(message)) return null;
    throw new SpawnfileError("runtime_error", "Unable to determine container identity state");
  }
};

export const assertExclusiveVolumesAvailable = async (
  report: DistributionReport,
  deploymentLineage: string,
  deploymentContainerName: string,
  runDocker: DockerCommandRunner
): Promise<void> => {
  for (const mount of report.persistent_mounts.filter(
    (candidate) => candidate.lifecycle === "exclusive-reattach"
  )) {
    const volume = derivePersistentMountVolumeName(deploymentLineage, mount);
    const occupants = (await runDocker([
      "ps", "--filter", `volume=${volume}`, "--format", "{{.Names}}"
    ])).toString("utf8").split("\n").map((name) => name.trim()).filter(Boolean);
    if (occupants.some((name) => name !== deploymentContainerName)) {
      throw new SpawnfileError(
        "runtime_error",
        `Exclusive persistent mount ${mount.id} is attached to another running deployment; stop that deployment before reattaching the realm`
      );
    }
  }
};

const reservationName = (volumeDigest: string): string =>
  `spawnfile-volume-reservation-${volumeDigest.slice("sha256:".length, 24 + "sha256:".length)}`;

const inspectReservation = async (
  runDocker: DockerCommandRunner,
  record: ReservationRecord
): Promise<void> => {
  try {
    const output = (await runDocker([
      "container", "inspect", "--format", reservationFormat, record.id
    ])).toString("utf8").trim().split("\n");
    if (output.length !== 2) throw new Error("shape");
    const id = JSON.parse(output[0]!) as unknown;
    const labels = JSON.parse(output[1]!) as unknown;
    if (id !== record.id || !labels || typeof labels !== "object" || Array.isArray(labels)) throw new Error("identity");
    const values = labels as Record<string, unknown>;
    if (values[reservationVersionLabel] !== "v1"
      || values[reservationOwnerLabel] !== record.owner
      || values[reservationVolumeLabel] !== record.volumeDigest) throw new Error("authority");
  } catch {
    throw new SpawnfileError("runtime_error", "Exclusive persistent mount reservation identity is unavailable");
  }
};

const releaseReservations = async (
  runDocker: DockerCommandRunner,
  records: readonly ReservationRecord[]
): Promise<void> => {
  let failed = false;
  for (const record of [...records].reverse()) {
    try {
      await inspectReservation(runDocker, record);
      await runDocker(["container", "rm", record.id]);
    } catch { failed = true; }
  }
  if (failed) throw new SpawnfileError("runtime_error", "Unable to release exclusive persistent mount reservation");
};

export const acquireExclusiveVolumeReservations = async (
  report: DistributionReport,
  deploymentLineage: string,
  deploymentContainerName: string,
  imageReference: string,
  runDocker: DockerCommandRunner
): Promise<ExclusiveVolumeReservation> => {
  const volumes = report.persistent_mounts
    .filter((mount) => mount.lifecycle === "exclusive-reattach")
    .map((mount) => derivePersistentMountVolumeName(deploymentLineage, mount))
    .sort();
  const records: ReservationRecord[] = [];
  try {
    for (const volume of volumes) {
      const volumeDigest = `sha256:${createHash("sha256").update(volume).digest("hex")}`;
      const owner = randomUUID();
      const name = reservationName(volumeDigest);
      let id: string;
      try {
        id = (await runDocker([
          "container", "create", "--name", name,
          "--label", `${reservationVersionLabel}=v1`,
          "--label", `${reservationOwnerLabel}=${owner}`,
          "--label", `${reservationVolumeLabel}=${volumeDigest}`,
          imageReference
        ])).toString("utf8").trim();
      } catch {
        throw new SpawnfileError("runtime_error", "Exclusive persistent mount reservation is already held");
      }
      if (!dockerId.test(id)) throw new SpawnfileError("runtime_error", "Exclusive persistent mount reservation returned invalid identity");
      const record = { id, name, owner, volumeDigest };
      records.push(record);
      await inspectReservation(runDocker, record);
    }
    await assertExclusiveVolumesAvailable(report, deploymentLineage, deploymentContainerName, runDocker);
  } catch (error) {
    if (records.length > 0) await releaseReservations(runDocker, records);
    throw error;
  }
  let released = false;
  return {
    release: async () => {
      if (released) return;
      await releaseReservations(runDocker, records);
      released = true;
    }
  };
};

const parseCandidateState = (raw: Buffer): { snapshot: ContainerSnapshot; state: ContainerState } => {
  try {
    const [idRaw, nameRaw, stateRaw, ...extra] = raw.toString("utf8").trim().split("\n");
    if (!idRaw || !nameRaw || !stateRaw || extra.length > 0) throw new Error("shape");
    const id = JSON.parse(idRaw) as unknown;
    const name = JSON.parse(nameRaw) as unknown;
    const state = JSON.parse(stateRaw) as ContainerState;
    if (typeof id !== "string" || !dockerId.test(id)
      || typeof name !== "string" || !name.startsWith("/") || name.length < 2
      || !state || typeof state !== "object" || typeof state.Running !== "boolean") throw new Error("values");
    return { snapshot: { id, name: name.slice(1), running: state.Running }, state };
  } catch {
    throw new SpawnfileError("runtime_error", "Candidate container returned invalid readiness state");
  }
};

export const assertCandidateContainerReady = async (
  runDocker: DockerCommandRunner,
  candidateId: string,
  expectedName: string
): Promise<void> => {
  if (!dockerId.test(candidateId)) throw new SpawnfileError("runtime_error", "Candidate container returned invalid identity");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const { snapshot, state } = parseCandidateState(await runDocker([
      "container", "inspect", "--format", "{{json .Id}}\n{{json .Name}}\n{{json .State}}", candidateId
    ]));
    if (snapshot.id !== candidateId || snapshot.name !== expectedName) {
      throw new SpawnfileError("runtime_error", "Candidate container identity did not match detached run");
    }
    const health = state.Health?.Status;
    if (state.Running === true && (health === undefined || health === "healthy")) return;
    if (state.Running !== true || (health !== undefined && health !== "starting")) break;
    await delay(1_000);
  }
  throw new SpawnfileError("runtime_error", "Candidate container did not become ready");
};

export const assertContainerStopped = async (
  runDocker: DockerCommandRunner,
  reference: string,
  expectedId: string
): Promise<void> => {
  const observed = await inspectContainerSnapshot(runDocker, reference);
  if (observed === null || observed.id !== expectedId || observed.running) {
    throw new SpawnfileError("runtime_error", "Prior container did not reach a verified stopped state");
  }
};

export const restorePreviousContainer = async (
  runDocker: DockerCommandRunner,
  previous: ContainerSnapshot,
  backupName: string,
  deploymentName: string
): Promise<void> => {
  const backup = await inspectContainerSnapshot(runDocker, backupName);
  if (backup === null || backup.id !== previous.id) {
    throw new SpawnfileError("runtime_error", "Prior container rollback identity is unavailable");
  }
  await runDocker(["rename", backupName, deploymentName]);
  if (previous.running !== backup.running) {
    await runDocker([previous.running ? "start" : "stop", previous.id]);
  }
  const restored = await inspectContainerSnapshot(runDocker, previous.id);
  if (restored === null || restored.id !== previous.id || restored.name !== deploymentName
    || restored.running !== previous.running) {
    throw new SpawnfileError("runtime_error", "Prior container rollback state could not be verified");
  }
};

export const rollbackCandidateContainer = async (
  runDocker: DockerCommandRunner,
  candidateId: string | undefined,
  candidateName: string,
  previous: ContainerSnapshot | null,
  backupName: string
): Promise<void> => {
  const failed: string[] = [];
  if (candidateId !== undefined) {
    try {
      const candidate = await inspectContainerSnapshot(runDocker, candidateId);
      if (candidate !== null) {
        if (candidate.id !== candidateId || candidate.name !== candidateName) throw new Error("identity");
        await runDocker(["rm", "-f", candidateId]);
      }
    } catch { failed.push("candidate cleanup"); }
  }
  if (previous !== null) {
    try { await restorePreviousContainer(runDocker, previous, backupName, candidateName); }
    catch { failed.push("prior restore"); }
  }
  if (failed.length > 0) {
    throw new SpawnfileError(
      "runtime_error",
      `Candidate deployment failed and rollback was incomplete (${failed.join(", ")})`
    );
  }
};
