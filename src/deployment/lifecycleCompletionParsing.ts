import { SpawnfileError } from "../shared/index.js";
import { parseExportIndex } from "./artifactsExportTypes.js";
import { parseDownReceipt } from "./downReceiptTypes.js";
import {
  canonicalLifecycleJson,
  lifecycleAdmissionSchema,
  lifecycleAmbiguousSchema,
  lifecycleCompletionSchema,
  lifecycleExportOutcomeSchema,
  lifecycleHeartbeatSchema,
  lifecycleInvocationSchema,
  lifecycleTerminalSchema,
  type LifecycleCompletion,
  type LifecycleAdmission,
  type LifecycleAmbiguousReason,
  type LifecycleTerminal,
  type LifecycleInvocation,
  type LifecycleHeartbeat,
} from "./lifecycleCompletionContracts.js";
import { parseUpReceipt } from "./upReceiptTypes.js";

const refuse = (message: string): never => {
  throw new SpawnfileError(
    "runtime_error",
    `Lifecycle completion store refused: ${message}`,
  );
};

export const parseLifecycleInvocation = (raw: unknown): LifecycleInvocation => {
  const parsed = lifecycleInvocationSchema.safeParse(raw);
  if (!parsed.success) refuse("invalid invocation contract");
  return parsed.data!;
};

export const parseLifecycleHeartbeat = (
  text: string,
): LifecycleHeartbeat => {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    refuse("corrupt heartbeat");
  }
  const parsed = lifecycleHeartbeatSchema.safeParse(raw);
  if (!parsed.success || `${canonicalLifecycleJson(parsed.data!)}\n` !== text)
    refuse("corrupt heartbeat");
  return parsed.data!;
};

export const parseLifecycleAdmission = (text: string): LifecycleAdmission => {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    refuse("corrupt admission");
  }
  const parsed = lifecycleAdmissionSchema.safeParse(raw);
  if (!parsed.success || `${canonicalLifecycleJson(parsed.data!)}\n` !== text)
    refuse("noncanonical admission");
  return parsed.data!;
};

export const parseLifecycleCompletion = (text: string): LifecycleCompletion => {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    refuse("corrupt completion");
  }
  const parsed = lifecycleCompletionSchema.safeParse(raw);
  if (!parsed.success || `${canonicalLifecycleJson(parsed.data!)}\n` !== text)
    refuse("corrupt completion");
  const value = parsed.data!;
  let outcome: unknown;
  try {
    outcome = JSON.parse(value.outcome_bytes);
  } catch {
    refuse("corrupt outcome");
  }
  if (JSON.stringify(outcome, null, 2) !== value.outcome_bytes)
    refuse("noncanonical outcome");
  try {
    if (value.invocation.operation === "up") parseUpReceipt(outcome);
    else if (value.invocation.operation === "down") parseDownReceipt(outcome);
    else parseExportIndex(lifecycleExportOutcomeSchema.parse(outcome).index);
  } catch {
    refuse("outcome operation mismatch");
  }
  return value;
};

export const parseLifecycleAmbiguous = (
  text: string,
): {
  invocation_digest: string;
  reason_code: LifecycleAmbiguousReason;
  version: "spawnfile.lifecycle-ambiguous.v1";
} => {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    refuse("corrupt ambiguous record");
  }
  const parsed = lifecycleAmbiguousSchema.safeParse(raw);
  if (!parsed.success || `${canonicalLifecycleJson(parsed.data!)}\n` !== text)
    refuse("corrupt ambiguous record");
  return parsed.data!;
};

export const parseLifecycleTerminal = (text: string): LifecycleTerminal => {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    refuse("corrupt terminal record");
  }
  const parsed = lifecycleTerminalSchema.safeParse(raw);
  if (!parsed.success || `${canonicalLifecycleJson(parsed.data!)}\n` !== text)
    refuse("corrupt terminal record");
  if (parsed.data!.status === "completed")
    parseLifecycleCompletion(
      `${canonicalLifecycleJson(parsed.data!.completion)}\n`,
    );
  return parsed.data!;
};

export const parseLifecycleCompletedTerminal = (
  text: string,
): LifecycleCompletion => {
  const terminal = parseLifecycleTerminal(text);
  if (terminal.status !== "completed") refuse("ambiguous terminal");
  return (terminal as { completion: LifecycleCompletion }).completion;
};
