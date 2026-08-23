import path from "node:path";

import { readSettledLifecycleRecord } from "./lifecycleCompletionPublication.js";
import {
  canonicalLifecycleJson,
  lifecycleUpCleanupSchema,
  lifecycleUpReservationSchema,
  lifecycleUpStartSchema,
  LIFECYCLE_UP_CLEANUP_VERSION,
  LIFECYCLE_UP_RESERVATION_VERSION,
  LIFECYCLE_UP_START_VERSION,
  type LifecycleAdmission,
  type LifecycleInvocation,
  type LifecycleOwnerCapability,
  type LifecycleUpReservation,
  type LifecycleUpStart,
} from "./lifecycleCompletionContracts.js";
import { assertLifecycleOwnerCapability } from "./lifecycleCompletionOwner.js";
import { parseLifecycleAdmission, parseLifecycleInvocation } from "./lifecycleCompletionParsing.js";
import {
  admissionPath,
  failLifecycleStore,
  lifecycleRecordName,
  lifecycleRoot,
  publishLifecycleRecord,
  readLifecycleRecord,
  recoveryPath,
  upCleanupPath,
  upReservationPath,
  upStartPath,
} from "./lifecycleCompletionStore.js";

export {
  LIFECYCLE_UP_EXTRA_LABELS,
  type LifecycleUpReservation,
  type LifecycleUpStart,
} from "./lifecycleCompletionContracts.js";

const MAX_ATTEMPTS = 16;
const canonical = canonicalLifecycleJson;
const fail = failLifecycleStore;

const exactAdmission = async (invocation: LifecycleInvocation): Promise<LifecycleAdmission> => {
  const text = await readSettledLifecycleRecord(admissionPath(invocation.id), readLifecycleRecord);
  if (text === null) return fail("missing admission");
  const admission = parseLifecycleAdmission(text);
  if (canonical(admission.invocation) !== canonical(invocation)) fail("invocation id drift");
  return admission;
};

const assertOwner = async (
  invocation: LifecycleInvocation,
  capability: LifecycleOwnerCapability,
): Promise<void> => {
  const recoveryText = await readSettledLifecycleRecord(recoveryPath(invocation.id), readLifecycleRecord);
  const recovered = recoveryText ? parseLifecycleAdmission(recoveryText) : null;
  assertLifecycleOwnerCapability(invocation, await exactAdmission(invocation), recovered, capability);
};

const parseRecord = <T>(text: string, parse: (raw: unknown) => T, invocation: LifecycleInvocation): T => {
  const value = (() => {
    try { return parse(JSON.parse(text)); } catch { return fail("invalid up lifecycle record"); }
  })();
  const record = value as { invocation: LifecycleInvocation };
  if (`${canonical(value!)}\n` !== text || canonical(record.invocation) !== canonical(invocation)) {
    fail("invocation id drift");
  }
  return value!;
};

export const findLifecycleUpReservation = async (
  raw: LifecycleInvocation,
): Promise<LifecycleUpReservation | null> => {
  const invocation = parseLifecycleInvocation(raw);
  if (invocation.operation !== "up") fail("non-up reservation lookup");
  await lifecycleRoot();
  const text = await readSettledLifecycleRecord(upReservationPath(invocation.id), readLifecycleRecord);
  return text === null ? null : parseRecord(text, (value) => lifecycleUpReservationSchema.parse(value), invocation);
};

export const recordLifecycleUpReservation = async (
  raw: LifecycleInvocation,
  reservation: Omit<LifecycleUpReservation, "invocation" | "version">,
  capability: LifecycleOwnerCapability,
): Promise<void> => {
  const invocation = parseLifecycleInvocation(raw);
  if (invocation.operation !== "up") fail("non-up reservation record");
  const directory = await lifecycleRoot();
  await assertOwner(invocation, capability);
  const value = lifecycleUpReservationSchema.parse({
    ...reservation, invocation, version: LIFECYCLE_UP_RESERVATION_VERSION,
  });
  await publishLifecycleRecord(directory, lifecycleRecordName(invocation.id, "up-reservation"), `${canonical(value)}\n`);
};

export interface LifecycleUpStartState {
  readonly attempt: number;
  readonly start: LifecycleUpStart;
}

const readStart = async (invocation: LifecycleInvocation, attempt: number): Promise<LifecycleUpStart | null> => {
  const text = await readSettledLifecycleRecord(upStartPath(invocation.id, attempt), readLifecycleRecord);
  return text === null ? null : parseRecord(text, (value) => lifecycleUpStartSchema.parse(value), invocation);
};

const readCleanup = async (invocation: LifecycleInvocation, attempt: number) => {
  const text = await readSettledLifecycleRecord(upCleanupPath(invocation.id, attempt), readLifecycleRecord);
  return text === null ? null : parseRecord(text, (value) => lifecycleUpCleanupSchema.parse(value), invocation);
};

const findUpAttempt = async (invocation: LifecycleInvocation): Promise<{
  active: LifecycleUpStartState | null;
  next: number;
}> => {
  for (let attempt = 0; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const start = await readStart(invocation, attempt);
    if (start === null) {
      if (await readCleanup(invocation, attempt)) fail("up cleanup without start");
      return { active: null, next: attempt };
    }
    if (start.attempt !== attempt) fail("up start attempt drift");
    const cleanup = await readCleanup(invocation, attempt);
    if (cleanup === null) return { active: { attempt, start }, next: attempt };
    if (cleanup.attempt !== attempt || cleanup.container_id !== start.container_id) fail("up cleanup drift");
  }
  return fail("up retry limit reached");
};

export const findLifecycleUpStart = async (raw: LifecycleInvocation): Promise<LifecycleUpStartState | null> => {
  const invocation = parseLifecycleInvocation(raw);
  if (invocation.operation !== "up") fail("non-up start lookup");
  await lifecycleRoot();
  return (await findUpAttempt(invocation)).active;
};

const sameAuthority = (reservation: LifecycleUpReservation, start: LifecycleUpStart): boolean =>
  reservation.container_name === start.container_name
  && canonical(reservation.label_authority) === canonical(start.label_authority);

export const recordLifecycleUpStart = async (
  raw: LifecycleInvocation,
  start: Omit<LifecycleUpStart, "attempt" | "invocation" | "version">,
  capability: LifecycleOwnerCapability,
): Promise<void> => {
  const invocation = parseLifecycleInvocation(raw);
  if (invocation.operation !== "up") fail("non-up start record");
  const directory = await lifecycleRoot();
  await assertOwner(invocation, capability);
  const reservation = await findLifecycleUpReservation(invocation);
  if (!reservation) return fail("missing up reservation");
  const current = await findUpAttempt(invocation);
  const value = lifecycleUpStartSchema.parse({ ...start, attempt: current.next, invocation, version: LIFECYCLE_UP_START_VERSION });
  if (!sameAuthority(reservation, value)) fail("up start authority drift");
  if (current.active) {
    if (canonical(current.active.start) !== canonical(value)) fail("active up start changed");
    return;
  }
  await publishLifecycleRecord(directory, path.basename(upStartPath(invocation.id, current.next)), `${canonical(value)}\n`);
};

export const recordLifecycleUpCleanup = async (
  raw: LifecycleInvocation,
  state: LifecycleUpStartState,
  capability: LifecycleOwnerCapability,
): Promise<void> => {
  const invocation = parseLifecycleInvocation(raw);
  const directory = await lifecycleRoot();
  await assertOwner(invocation, capability);
  const active = await findUpAttempt(invocation);
  if (!active.active || active.active.attempt !== state.attempt
    || canonical(active.active.start) !== canonical(state.start)) fail("up cleanup without active start");
  const value = lifecycleUpCleanupSchema.parse({
    attempt: state.attempt, container_id: state.start.container_id, invocation,
    version: LIFECYCLE_UP_CLEANUP_VERSION,
  });
  await publishLifecycleRecord(directory, path.basename(upCleanupPath(invocation.id, state.attempt)), `${canonical(value)}\n`);
};
