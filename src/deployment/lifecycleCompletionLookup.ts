import { SpawnfileError } from "../shared/index.js";
import {
  canonicalLifecycleJson,
  lifecycleDigest,
  lifecycleIdSchema,
  LIFECYCLE_LOOKUP_VERSION,
  type LifecycleInvocation,
  type LifecycleLookup,
} from "./lifecycleCompletionContracts.js";
import { lifecycleOwnerIsAlive } from "./lifecycleCompletionOwner.js";
import {
  parseLifecycleAdmission,
  parseLifecycleHeartbeat,
  parseLifecycleTerminal,
} from "./lifecycleCompletionParsing.js";

interface LookupStorage {
  admissionPath: (id: string) => string;
  completionPath: (id: string) => string;
  existingRoot: () => Promise<string | null>;
  read: (file: string) => Promise<string | null>;
  heartbeatPath: (id: string) => string;
  recoveryPath: (id: string) => string;
}

export const findLifecycleInvocationRecord = async (
  id: string,
  storage: Pick<LookupStorage, "admissionPath" | "existingRoot" | "read">,
) => {
  const parsed = lifecycleIdSchema.safeParse(id);
  if (!parsed.success) refuse("invalid invocation id");
  if ((await storage.existingRoot()) === null) return null;
  const text = await storage.read(storage.admissionPath(parsed.data!));
  return text === null ? null : parseLifecycleAdmission(text).invocation;
};

const refuse = (message: string): never => {
  throw new SpawnfileError(
    "runtime_error",
    `Lifecycle completion store refused: ${message}`,
  );
};

export const lookupLifecycleCompletionRecord = async (
  id: string,
  storage: LookupStorage,
): Promise<LifecycleLookup> => {
  const parsed = lifecycleIdSchema.safeParse(id);
  if (!parsed.success) refuse("invalid invocation id");
  const value = parsed.data!;
  if ((await storage.existingRoot()) === null)
    return {
      invocation_id: value,
      status: "not_applied",
      version: LIFECYCLE_LOOKUP_VERSION,
    };
  const admissionText = await storage.read(storage.admissionPath(value));
  const completionText = await storage.read(storage.completionPath(value));
  const recoveryText = await storage.read(storage.recoveryPath(value));
  const heartbeatText = await storage.read(storage.heartbeatPath(value));
  if (
    admissionText === null &&
    (completionText !== null || recoveryText !== null)
  )
    refuse("completion without admission");
  if (admissionText === null)
    return {
      invocation_id: value,
      status: "not_applied",
      version: LIFECYCLE_LOOKUP_VERSION,
    };
  const admission = parseLifecycleAdmission(admissionText);
  if (completionText !== null) {
    const terminal = parseLifecycleTerminal(completionText);
    if (terminal.status === "completed") {
      if (
        canonicalLifecycleJson(terminal.completion.invocation) !==
        canonicalLifecycleJson(admission.invocation)
      )
        refuse("completion admission drift");
      return {
        invocation_digest: lifecycleDigest(terminal.completion.invocation),
        operation: terminal.completion.invocation.operation,
        outcome_bytes: terminal.completion.outcome_bytes,
        status: "completed",
        version: LIFECYCLE_LOOKUP_VERSION,
      };
    }
    const ambiguous = terminal.ambiguous;
    if (ambiguous.invocation_digest !== lifecycleDigest(admission.invocation))
      refuse("corrupt ambiguous record");
    return {
      invocation_digest: ambiguous.invocation_digest,
      operation: admission.invocation.operation,
      reason_code: ambiguous.reason_code,
      status: "ambiguous",
      version: LIFECYCLE_LOOKUP_VERSION,
    };
  }
  if (recoveryText !== null) {
    const recovery = parseLifecycleAdmission(recoveryText);
    if (
      canonicalLifecycleJson(recovery.invocation) !==
      canonicalLifecycleJson(admission.invocation)
    )
      refuse("invocation id drift");
    if (
      !lifecycleOwnerIsAlive(
        recovery.owner,
        heartbeatText ? parseLifecycleHeartbeat(heartbeatText) : null,
      )
    ) {
      return {
        invocation_digest: lifecycleDigest(admission.invocation),
        operation: admission.invocation.operation,
        reason_code: "recovery_owner_died",
        status: "ambiguous",
        version: LIFECYCLE_LOOKUP_VERSION,
      };
    }
  }
  return {
    invocation_digest: lifecycleDigest(admission.invocation),
    operation: admission.invocation.operation,
    status: "pending",
    version: LIFECYCLE_LOOKUP_VERSION,
  };
};
