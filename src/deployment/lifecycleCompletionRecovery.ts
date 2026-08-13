import {
  canonicalLifecycleJson,
  lifecycleAmbiguousSchema,
  lifecycleDigest,
  LIFECYCLE_TERMINAL_VERSION,
  type LifecycleAdmission,
  type LifecycleAmbiguousReason,
  type LifecycleCompletion,
  type LifecycleInvocation,
  type LifecycleOwnerCapability,
} from "./lifecycleCompletionContracts.js";
import {
  assertLifecycleOwnerCapability,
  createLifecycleAdmission,
  lifecycleOwnerIsAlive,
} from "./lifecycleCompletionOwner.js";
import { parseLifecycleAdmission } from "./lifecycleCompletionParsing.js";

interface RecoveryStorage {
  exactAdmission: (
    invocation: LifecycleInvocation,
  ) => Promise<LifecycleAdmission | null>;
  exactCompletion: (
    invocation: LifecycleInvocation,
  ) => Promise<LifecycleCompletion | null>;
  publish: (
    invocation: LifecycleInvocation,
    kind: "completion" | "recovery",
    content: string,
  ) => Promise<boolean>;
  readRecovery: (invocation: LifecycleInvocation) => Promise<string | null>;
  readHeartbeat: (
    invocation: LifecycleInvocation,
  ) => Promise<{ epoch: string; lease_expires_at: number } | null>;
}

export type LifecycleRecoveryClaim =
  | { capability: LifecycleOwnerCapability; status: "owner" }
  | { status: "ambiguous" | "pending" | "replay" };

const ambiguousTerminal = (
  invocation: LifecycleInvocation,
  reasonCode: LifecycleAmbiguousReason,
): string => {
  const ambiguous = lifecycleAmbiguousSchema.parse({
    invocation_digest: lifecycleDigest(invocation),
    reason_code: reasonCode,
    version: "spawnfile.lifecycle-ambiguous.v1",
  });
  return `${canonicalLifecycleJson({
    ambiguous,
    status: "ambiguous",
    version: LIFECYCLE_TERMINAL_VERSION,
  })}\n`;
};

export const materializeDeadRecoveryAmbiguous = async (
  invocation: LifecycleInvocation,
  publish: RecoveryStorage["publish"],
): Promise<void> => {
  await publish(
    invocation,
    "completion",
    ambiguousTerminal(invocation, "recovery_owner_died"),
  );
};

export const claimLifecycleRecoveryRecord = async (
  invocation: LifecycleInvocation,
  storage: RecoveryStorage,
): Promise<LifecycleRecoveryClaim> => {
  const stored = await storage.exactAdmission(invocation);
  const completion = await storage.exactCompletion(invocation);
  if (!stored) throw new Error("missing admission");
  if (completion) return { status: "replay" };
  if (
    lifecycleOwnerIsAlive(
      stored.owner,
      await storage.readHeartbeat(invocation),
    )
  )
    return { status: "pending" };
  const recovery = createLifecycleAdmission(invocation);
  if (
    await storage.publish(
      invocation,
      "recovery",
      `${canonicalLifecycleJson(recovery)}\n`,
    )
  )
    return {
      capability: { epoch: recovery.owner.epoch, role: "recovery" },
      status: "owner",
    };
  const text = await storage.readRecovery(invocation);
  if (text === null) throw new Error("missing recovery owner");
  const prior = parseLifecycleAdmission(text);
  if (
    canonicalLifecycleJson(prior.invocation) !==
    canonicalLifecycleJson(invocation)
  )
    throw new Error("invocation id drift");
  if (
    lifecycleOwnerIsAlive(
      prior.owner,
      await storage.readHeartbeat(invocation),
    )
  )
    return { status: "pending" };
  await materializeDeadRecoveryAmbiguous(invocation, storage.publish);
  return { status: "ambiguous" };
};

export const markLifecycleAmbiguousRecord = async (
  invocation: LifecycleInvocation,
  reasonCode: LifecycleAmbiguousReason,
  capability: LifecycleOwnerCapability,
  storage: RecoveryStorage,
): Promise<void> => {
  const admitted = await storage.exactAdmission(invocation);
  if (!admitted) throw new Error("missing admission");
  const recoveryText = await storage.readRecovery(invocation);
  const recovered = recoveryText ? parseLifecycleAdmission(recoveryText) : null;
  assertLifecycleOwnerCapability(invocation, admitted, recovered, capability);
  if (capability.role !== "recovery")
    throw new Error("invalid owner capability");
  await storage.publish(
    invocation,
    "completion",
    ambiguousTerminal(invocation, reasonCode),
  );
};
