import { randomUUID } from "node:crypto";

import {
  LIFECYCLE_ADMISSION_VERSION,
  LIFECYCLE_OWNER_VERSION,
  canonicalLifecycleJson,
  type LifecycleAdmission,
  type LifecycleInvocation,
  type LifecycleOwnerCapability,
} from "./lifecycleCompletionContracts.js";
import { SpawnfileError } from "../shared/index.js";

export const LIFECYCLE_LEASE_MS = 30_000;
export const createLifecycleAdmission = (
  invocation: LifecycleInvocation,
): LifecycleAdmission => ({
  invocation,
  owner: {
    epoch: randomUUID(),
    lease_expires_at: Date.now() + LIFECYCLE_LEASE_MS,
    pid: process.pid,
    version: LIFECYCLE_OWNER_VERSION,
  },
  version: LIFECYCLE_ADMISSION_VERSION,
});

export const lifecycleOwnerIsAlive = (
  owner: LifecycleAdmission["owner"],
  heartbeat?: { epoch: string; lease_expires_at: number } | null,
): boolean => {
  const expiry =
    heartbeat?.epoch === owner.epoch
      ? heartbeat.lease_expires_at
      : owner.lease_expires_at;
  return expiry > Date.now();
};

export const assertLifecycleOwnerCapability = (
  invocation: LifecycleInvocation,
  admitted: LifecycleAdmission,
  recovered: LifecycleAdmission | null,
  capability: LifecycleOwnerCapability,
): void => {
  if (
    recovered &&
    canonicalLifecycleJson(recovered.invocation) !==
      canonicalLifecycleJson(invocation)
  )
    throw new SpawnfileError("runtime_error", "Lifecycle invocation id drift");
  const active = recovered
    ? { epoch: recovered.owner.epoch, role: "recovery" }
    : { epoch: admitted.owner.epoch, role: "initial" };
  if (capability?.epoch !== active.epoch || capability?.role !== active.role)
    throw new SpawnfileError(
      "runtime_error",
      "Lifecycle completion store refused: invalid owner capability",
    );
};
