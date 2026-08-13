import { createHash } from "node:crypto";

import {
  claimLifecycleInvocation,
  claimLifecycleRecovery,
  completeLifecycleInvocation,
  findExactLifecycleCompletion,
  markLifecycleAmbiguous,
  renewLifecycleOwner,
  type LifecycleInvocation,
} from "../deployment/index.js";
import { SpawnfileError } from "../shared/index.js";

export const createLifecycleInvocation = (
  id: string,
  operation: LifecycleInvocation["operation"],
  correlation: LifecycleInvocation["correlation"],
  requestPolicy: LifecycleInvocation["request_policy"],
): LifecycleInvocation => ({
  correlation,
  id,
  operation,
  request_policy: requestPolicy,
  version: "spawnfile.lifecycle-invocation.v1",
});

export const digestLifecycleBinding = (
  value: string | undefined,
): string | null =>
  value === undefined
    ? null
    : `sha256:${createHash("sha256").update(value).digest("hex")}`;

export type LifecycleReconciliation =
  | { outcomeBytes: string; status: "completed" }
  | { status: "provably_not_applied" }
  | { status: "resume_safe" }
  | { reason: string; status: "ambiguous" };

const withLifecycleHeartbeat = async <T>(
  invocation: LifecycleInvocation,
  capability: { epoch: string; role: "initial" | "recovery" },
  task: () => Promise<T>,
): Promise<T> => {
  await renewLifecycleOwner(invocation, capability);
  let failure: unknown;
  const timer = setInterval(() => {
    void renewLifecycleOwner(invocation, capability).catch((error) => {
      failure = error;
    });
  }, 10_000);
  timer.unref();
  try {
    const result = await task();
    if (failure) throw failure;
    return result;
  } finally {
    clearInterval(timer);
  }
};

export const runMachineLifecycle = async (
  invocation: LifecycleInvocation,
  owner: (capability: {
    epoch: string;
    role: "initial" | "recovery";
  }) => Promise<string>,
  reconcile?: () => Promise<LifecycleReconciliation>,
): Promise<string> => {
  const existing = await findExactLifecycleCompletion(invocation);
  if (existing) return existing.outcome_bytes;
  const claim = await claimLifecycleInvocation(invocation);
  if (claim.status === "replay") {
    const replay = await findExactLifecycleCompletion(invocation);
    if (!replay) {
      throw new SpawnfileError(
        "runtime_error",
        "Lifecycle replay completion disappeared",
      );
    }
    return replay.outcome_bytes;
  }
  if (claim.status === "pending" && reconcile) {
    const recovery = await claimLifecycleRecovery(invocation);
    if (recovery.status === "replay") {
      const completed = await findExactLifecycleCompletion(invocation);
      if (completed) return completed.outcome_bytes;
      throw new SpawnfileError(
        "runtime_error",
        "Lifecycle replay completion disappeared",
      );
    }
    if (recovery.status === "owner") {
      const verdict = await withLifecycleHeartbeat(
        invocation,
        recovery.capability,
        reconcile,
      );
      if (verdict.status === "completed") {
        return (
          await completeLifecycleInvocation(
            invocation,
            verdict.outcomeBytes,
            recovery.capability,
          )
        ).outcome_bytes;
      }
      if (
        verdict.status === "provably_not_applied" ||
        verdict.status === "resume_safe"
      ) {
        return (
          await completeLifecycleInvocation(
            invocation,
            await withLifecycleHeartbeat(
              invocation,
              recovery.capability,
              () => owner(recovery.capability),
            ),
            recovery.capability,
          )
        ).outcome_bytes;
      }
      await markLifecycleAmbiguous(
        invocation,
        "reconciliation_ambiguous",
        recovery.capability,
      );
      throw new SpawnfileError(
        "runtime_error",
        `Lifecycle recovery is ambiguous: ${verdict.reason}`,
      );
    }
    if (recovery.status === "ambiguous") {
      throw new SpawnfileError(
        "runtime_error",
        "Lifecycle recovery owner died; invocation is ambiguous",
      );
    }
  }
  if (claim.status !== "owner") {
    throw new SpawnfileError(
      "runtime_error",
      "Lifecycle invocation already has an in-flight owner",
    );
  }
  return (
    await completeLifecycleInvocation(
      invocation,
      await withLifecycleHeartbeat(invocation, claim.capability, () =>
        owner(claim.capability),
      ),
      claim.capability,
    )
  ).outcome_bytes;
};

export const requireMachineLifecycle = (
  invocationId: string | undefined,
  json: boolean | undefined,
): void => {
  if (invocationId !== undefined && !json) {
    throw new SpawnfileError(
      "validation_error",
      "--lifecycle-invocation is only valid with --json",
    );
  }
};
