import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { SpawnfileError } from "../shared/index.js";
import type { DockerRunInvocation, DockerRunResult } from "./runProjectDocker.js";

const execFile = promisify(execFileCallback);
const dockerId = /^[a-f0-9]{64}$/u;
const versionLabel = "com.spawnfile.exclusive-volume-reservation";
const ownerLabel = "com.spawnfile.exclusive-volume-owner";
const volumeLabel = "com.spawnfile.exclusive-volume-digest";

interface Reservation {
  readonly id: string;
  readonly owner: string;
  readonly volumeDigest: string;
}

const endpointArgs = (invocation: DockerRunInvocation): string[] => invocation.dockerContext
  ? ["--context", invocation.dockerContext]
  : invocation.dockerHost ? ["--host", invocation.dockerHost] : [];

const execute = async (
  invocation: DockerRunInvocation,
  args: readonly string[]
): Promise<string> => {
  const { stdout } = await execFile(invocation.command, [...endpointArgs(invocation), ...args], {
    cwd: invocation.cwd,
    timeout: 10_000
  });
  return stdout;
};

const reservationName = (digest: string): string =>
  `spawnfile-volume-reservation-${digest.slice("sha256:".length, "sha256:".length + 24)}`;

const verifyReservation = async (
  invocation: DockerRunInvocation,
  reservation: Reservation
): Promise<void> => {
  try {
    const [idRaw, labelsRaw, ...extra] = (await execute(invocation, [
      "container", "inspect", "--format", "{{json .Id}}\n{{json .Config.Labels}}", reservation.id
    ])).trim().split("\n");
    if (!idRaw || !labelsRaw || extra.length > 0) throw new Error("shape");
    const id = JSON.parse(idRaw) as unknown;
    const labels = JSON.parse(labelsRaw) as unknown;
    if (id !== reservation.id || !labels || typeof labels !== "object" || Array.isArray(labels)) throw new Error("identity");
    const values = labels as Record<string, unknown>;
    if (values[versionLabel] !== "v1" || values[ownerLabel] !== reservation.owner
      || values[volumeLabel] !== reservation.volumeDigest) throw new Error("authority");
  } catch {
    throw new SpawnfileError("runtime_error", "Exclusive persistent mount reservation identity is unavailable");
  }
};

const release = async (
  invocation: DockerRunInvocation,
  reservations: readonly Reservation[]
): Promise<void> => {
  let failed = false;
  for (const reservation of [...reservations].reverse()) {
    try {
      await verifyReservation(invocation, reservation);
      await execute(invocation, ["container", "rm", reservation.id]);
    } catch { failed = true; }
  }
  if (failed) throw new SpawnfileError("runtime_error", "Unable to release exclusive persistent mount reservation");
};

const assertAvailable = async (invocation: DockerRunInvocation): Promise<void> => {
  for (const volume of invocation.exclusiveReattachVolumes ?? []) {
    let stdout: string;
    try {
      stdout = await execute(invocation, [
        "ps", "--filter", `volume=${volume}`, "--format", "{{.Names}}"
      ]);
    } catch {
      throw new SpawnfileError("runtime_error", "Unable to verify exclusive persistent mount occupancy");
    }
    const occupants = stdout.split("\n").map((name) => name.trim()).filter(Boolean);
    if (occupants.some((name) => name !== invocation.containerName)) {
      throw new SpawnfileError(
        "runtime_error",
        "Exclusive persistent mount is attached to another running deployment; stop it before reattaching this lineage"
      );
    }
  }
};

const acquire = async (invocation: DockerRunInvocation): Promise<Reservation[]> => {
  const reservations: Reservation[] = [];
  const volumes = [...new Set(invocation.exclusiveReattachVolumes ?? [])].sort();
  try {
    for (const volume of volumes) {
      const volumeDigest = `sha256:${createHash("sha256").update(volume).digest("hex")}`;
      const owner = randomUUID();
      let id: string;
      try {
        id = (await execute(invocation, [
          "container", "create", "--name", reservationName(volumeDigest),
          "--label", `${versionLabel}=v1`,
          "--label", `${ownerLabel}=${owner}`,
          "--label", `${volumeLabel}=${volumeDigest}`,
          invocation.imageTag
        ])).trim();
      } catch {
        throw new SpawnfileError("runtime_error", "Exclusive persistent mount reservation is already held");
      }
      if (!dockerId.test(id)) throw new SpawnfileError("runtime_error", "Exclusive persistent mount reservation returned invalid identity");
      const reservation = { id, owner, volumeDigest };
      reservations.push(reservation);
      await verifyReservation(invocation, reservation);
    }
    await assertAvailable(invocation);
    return reservations;
  } catch (error) {
    if (reservations.length > 0) await release(invocation, reservations);
    throw error;
  }
};

/** Holds daemon-side atomic volume reservations through verified startup. */
export const withExclusiveVolumeReservations = async (
  invocation: DockerRunInvocation,
  operation: () => Promise<DockerRunResult | void>
): Promise<DockerRunResult | void> => {
  if ((invocation.exclusiveReattachVolumes?.length ?? 0) === 0) return operation();
  const reservations = await acquire(invocation);
  try { return await operation(); }
  finally { await release(invocation, reservations); }
};
