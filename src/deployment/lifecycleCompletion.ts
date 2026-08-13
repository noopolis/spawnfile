import path from "node:path";

import { readSettledLifecycleRecord } from "./lifecycleCompletionPublication.js";
import {
  canonicalLifecycleJson,
  lifecycleIdSchema,
  LIFECYCLE_COMPLETION_VERSION,
  LIFECYCLE_TERMINAL_VERSION,
  type LifecycleAdmission,
  type LifecycleAmbiguousReason,
  type LifecycleCompletion,
  type LifecycleInvocation,
  type LifecycleOwnerCapability,
} from "./lifecycleCompletionContracts.js";
import {
  findLifecycleInvocationRecord,
  lookupLifecycleCompletionRecord,
} from "./lifecycleCompletionLookup.js";
import { writeLifecycleHeartbeat } from "./lifecycleCompletionHeartbeat.js";
import {
  assertLifecycleOwnerCapability,
  createLifecycleAdmission,
} from "./lifecycleCompletionOwner.js";
import {
  parseLifecycleAdmission,
  parseLifecycleCompletedTerminal,
  parseLifecycleCompletion,
  parseLifecycleHeartbeat,
  parseLifecycleInvocation,
} from "./lifecycleCompletionParsing.js";
import {
  claimLifecycleRecoveryRecord,
  markLifecycleAmbiguousRecord,
} from "./lifecycleCompletionRecovery.js";
import {
  admissionPath,
  evidencePath,
  existingLifecycleRoot as existingRoot,
  failLifecycleStore as fail,
  heartbeatPath,
  lifecycleRecordName as name,
  lifecycleRoot as root,
  planPath,
  publishLifecycleRecord as publish,
  readLifecycleRecord as read,
  recoveryPath,
  resolveLifecycleCompletionDirectory,
  resolveLifecycleCompletionPath,
  syncLifecycleDirectory as sync,
} from "./lifecycleCompletionStore.js";
export {
  LIFECYCLE_COMPLETION_VERSION,
  LIFECYCLE_INVOCATION_VERSION,
  LIFECYCLE_LOOKUP_VERSION,
  type LifecycleCompletion,
  type LifecycleInvocation,
  type LifecycleLookup,
  type LifecycleOwnerCapability,
} from "./lifecycleCompletionContracts.js";
const canonical = canonicalLifecycleJson;
export { resolveLifecycleCompletionDirectory, resolveLifecycleCompletionPath };
const exactAdmission = async (
  invocation: LifecycleInvocation,
): Promise<LifecycleAdmission | null> => {
  const text = await readSettledLifecycleRecord(
    admissionPath(invocation.id),
    read,
  );
  if (text === null) return null;
  const stored = parseLifecycleAdmission(text);
  if (canonical(stored.invocation) !== canonical(invocation))
    fail("invocation id drift");
  return stored;
};
const exactCompletion = async (
  invocation: LifecycleInvocation,
): Promise<LifecycleCompletion | null> => {
  const text = await readSettledLifecycleRecord(
    resolveLifecycleCompletionPath(invocation.id),
    read,
  );
  if (text === null) return null;
  const stored = parseLifecycleCompletedTerminal(text);
  if (canonical(stored.invocation) !== canonical(invocation))
    fail("invocation id drift");
  return stored;
};
export const findLifecycleInvocation = (id: string) =>
  (async () => {
    const parsed = lifecycleIdSchema.safeParse(id);
    if (!parsed.success) fail("invalid invocation id");
    if ((await existingRoot()) === null) return null;
    const value = parsed.data!;
    const admitted = await findLifecycleInvocationRecord(value, {
      admissionPath,
      existingRoot,
      read: (file) => readSettledLifecycleRecord(file, read),
    });
    if (admitted) return admitted;
    const text = await readSettledLifecycleRecord(planPath(value), read);
    if (text === null) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      fail("corrupt lifecycle plan");
    }
    const planned = parseLifecycleInvocation(raw);
    if (`${canonical(planned)}\n` !== text) fail("corrupt lifecycle plan");
    return planned;
  })();
const exactPlan = async (
  invocation: LifecycleInvocation,
): Promise<LifecycleInvocation | null> => {
  const text = await readSettledLifecycleRecord(planPath(invocation.id), read);
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail("corrupt lifecycle plan");
  }
  const stored = parseLifecycleInvocation(raw);
  if (
    `${canonical(stored)}\n` !== text ||
    canonical(stored) !== canonical(invocation)
  )
    fail("invocation id drift");
  return stored;
};
/**
 * Durably reserves one exact effect-free lifecycle plan. Execution later
 * promotes the same bytes to an admission or refuses id drift.
 */
export const admitLifecyclePlan = async (
  raw: LifecycleInvocation,
): Promise<LifecycleInvocation> => {
  const invocation = parseLifecycleInvocation(raw);
  const directory = await root();
  const admitted = await exactAdmission(invocation);
  const completed = await exactCompletion(invocation);
  if (completed && !admitted) fail("completion without admission");
  if (admitted) return invocation;
  const content = `${canonical(invocation)}\n`;
  await publish(directory, name(invocation.id, "plan"), content);
  await exactPlan(invocation);
  // Close the plan-vs-execution race: an admission published concurrently is
  // authoritative and must contain the same invocation bytes.
  await exactAdmission(invocation);
  return invocation;
};
export const findExactLifecycleCompletion = async (
  invocation: LifecycleInvocation,
): Promise<LifecycleCompletion | null> => {
  const parsed = parseLifecycleInvocation(invocation);
  await root();
  const admission = await exactAdmission(parsed);
  const completion = await exactCompletion(parsed);
  if (completion && !admission) fail("completion without admission");
  return completion;
};
export const claimLifecycleInvocation = async (raw: LifecycleInvocation) => {
  const invocation = parseLifecycleInvocation(raw);
  const directory = await root();
  const admission = await exactAdmission(invocation);
  // An existing admission is authoritative. Otherwise a prior read-only plan
  // reserves this id and must match before we publish the first effect owner.
  if (!admission) await exactPlan(invocation);
  const completion = await exactCompletion(invocation);
  if (completion && !admission) fail("completion without admission");
  if (completion) return { status: "replay" } as const;
  const createdAdmission = createLifecycleAdmission(invocation);
  const content = `${canonical(createdAdmission)}\n`;
  const created = await publish(
    directory,
    name(invocation.id, "admission"),
    content,
    "ignore",
  );
  if (created)
    return {
      capability: { epoch: createdAdmission.owner.epoch, role: "initial" },
      status: "owner",
    } as const;
  await exactAdmission(invocation);
  return {
    status: (await exactCompletion(invocation)) ? "replay" : "pending",
  } as const;
};
export const claimLifecycleRecovery = async (raw: LifecycleInvocation) => {
  const invocation = parseLifecycleInvocation(raw);
  const directory = await root();
  return claimLifecycleRecoveryRecord(invocation, {
    exactAdmission,
    exactCompletion,
    publish: (value, kind, content) =>
      publish(
        directory,
        name(value.id, kind),
        content,
        kind === "recovery" ? "ignore" : "match",
      ),
    readRecovery: (value) =>
      readSettledLifecycleRecord(recoveryPath(value.id), read),
    readHeartbeat: async (value) => {
      const text = await readSettledLifecycleRecord(
        heartbeatPath(value.id),
        read,
      );
      return text ? parseLifecycleHeartbeat(text) : null;
    },
  });
};
export const renewLifecycleOwner = async (
  raw: LifecycleInvocation,
  capability: LifecycleOwnerCapability,
): Promise<void> => {
  const invocation = parseLifecycleInvocation(raw);
  const directory = await root();
  const admitted = await exactAdmission(invocation);
  const exactAdmitted = admitted ?? fail("missing admission");
  const recoveryText = await readSettledLifecycleRecord(
    recoveryPath(invocation.id),
    read,
  );
  const recovered = recoveryText ? parseLifecycleAdmission(recoveryText) : null;
  assertLifecycleOwnerCapability(invocation, exactAdmitted, recovered, capability);
  await writeLifecycleHeartbeat(
    directory,
    path.basename(heartbeatPath(invocation.id)),
    capability.epoch,
    sync,
  );
};
const assertActiveCapability = async (
  invocation: LifecycleInvocation,
  capability: LifecycleOwnerCapability,
): Promise<void> => {
  const admitted = await exactAdmission(invocation);
  const exactAdmitted = admitted ?? fail("missing admission");
  const recoveryText = await readSettledLifecycleRecord(
    recoveryPath(invocation.id),
    read,
  );
  const recovered = recoveryText ? parseLifecycleAdmission(recoveryText) : null;
  assertLifecycleOwnerCapability(
    invocation,
    exactAdmitted,
    recovered,
    capability,
  );
};
export const recordLifecycleOutcomeEvidence = async (
  raw: LifecycleInvocation,
  outcomeBytes: string,
  capability: LifecycleOwnerCapability,
  deploymentInstanceDigest: string,
): Promise<void> => {
  const invocation = parseLifecycleInvocation(raw);
  const directory = await root();
  await assertActiveCapability(invocation, capability);
  const evidence = parseLifecycleCompletion(
    `${canonical({
      invocation,
      outcome_bytes: outcomeBytes,
      version: LIFECYCLE_COMPLETION_VERSION,
    })}\n`,
  );
  await publish(
    directory,
    name(invocation.id, "evidence"),
    `${canonical({
      completion: evidence,
      deployment_instance_digest: deploymentInstanceDigest,
      version: "spawnfile.lifecycle-evidence.v1",
    })}\n`,
  );
};
export const findLifecycleOutcomeEvidence = async (
  raw: LifecycleInvocation,
): Promise<{
  completion: LifecycleCompletion;
  deployment_instance_digest: string;
} | null> => {
  const invocation = parseLifecycleInvocation(raw);
  await root();
  await exactAdmission(invocation);
  const text = await readSettledLifecycleRecord(evidencePath(invocation.id), read);
  if (text === null) return null;
  const rawEvidence = JSON.parse(text) as Record<string, unknown>;
  if (
    rawEvidence.version !== "spawnfile.lifecycle-evidence.v1" ||
    typeof rawEvidence.deployment_instance_digest !== "string"
  )
    fail("invalid outcome evidence");
  const deploymentInstanceDigest =
    rawEvidence.deployment_instance_digest as string;
  const evidence = parseLifecycleCompletion(
    `${canonical(rawEvidence.completion)}\n`,
  );
  if (
    `${canonical(rawEvidence)}\n` !== text ||
    canonical(evidence.invocation) !== canonical(invocation)
  )
    fail("invocation id drift");
  return {
    completion: evidence,
    deployment_instance_digest: deploymentInstanceDigest,
  };
};
export const completeLifecycleInvocation = async (
  raw: LifecycleInvocation,
  outcomeBytes: string,
  capability: LifecycleOwnerCapability,
): Promise<LifecycleCompletion> => {
  const invocation = parseLifecycleInvocation(raw);
  const directory = await root();
  await assertActiveCapability(invocation, capability);
  const completion = parseLifecycleCompletion(
    `${canonical({ invocation, outcome_bytes: outcomeBytes, version: LIFECYCLE_COMPLETION_VERSION })}\n`,
  );
  await publish(
    directory,
    name(invocation.id, "completion"),
    `${canonical({
      completion,
      status: "completed",
      version: LIFECYCLE_TERMINAL_VERSION,
    })}\n`,
  );
  const stored = await exactCompletion(invocation);
  if (!stored) fail("missing completion");
  return parseLifecycleCompletion(`${canonical(stored)}\n`);
};
export const markLifecycleAmbiguous = async (
  raw: LifecycleInvocation,
  reasonCode: LifecycleAmbiguousReason,
  capability: LifecycleOwnerCapability,
): Promise<void> => {
  const invocation = parseLifecycleInvocation(raw);
  const directory = await root();
  await markLifecycleAmbiguousRecord(invocation, reasonCode, capability, {
    exactAdmission,
    exactCompletion,
    publish: (value, kind, content) =>
      publish(directory, name(value.id, kind), content),
    readRecovery: (value) =>
      readSettledLifecycleRecord(recoveryPath(value.id), read),
    readHeartbeat: async (value) => {
      const text = await readSettledLifecycleRecord(
        heartbeatPath(value.id),
        read,
      );
      return text ? parseLifecycleHeartbeat(text) : null;
    },
  });
};
export const lookupLifecycleCompletion = (id: string) =>
  lookupLifecycleCompletionRecord(id, {
    admissionPath,
    completionPath: resolveLifecycleCompletionPath,
    existingRoot,
    heartbeatPath,
    read: (file) => readSettledLifecycleRecord(file, read),
    recoveryPath,
  });
