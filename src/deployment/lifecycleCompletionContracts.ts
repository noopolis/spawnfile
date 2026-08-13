import { createHash } from "node:crypto";

import { z } from "zod";

export const LIFECYCLE_INVOCATION_VERSION =
  "spawnfile.lifecycle-invocation.v1" as const;
export const LIFECYCLE_COMPLETION_VERSION =
  "spawnfile.lifecycle-completion.v1" as const;
export const LIFECYCLE_LOOKUP_VERSION =
  "spawnfile.lifecycle-lookup.v1" as const;
export const LIFECYCLE_OWNER_VERSION = "spawnfile.lifecycle-owner.v1" as const;
export const LIFECYCLE_ADMISSION_VERSION =
  "spawnfile.lifecycle-admission.v1" as const;
export const LIFECYCLE_AMBIGUOUS_VERSION =
  "spawnfile.lifecycle-ambiguous.v1" as const;
export const LIFECYCLE_TERMINAL_VERSION =
  "spawnfile.lifecycle-terminal.v1" as const;
export const LIFECYCLE_RECORD_MAX_BYTES = 1_000_000;
export const lifecycleIdSchema = z
  .string()
  .regex(/^lci_[a-z0-9][a-z0-9_-]{15,127}$/u);
const scalar = z.union([
  z.string().max(512),
  z.boolean(),
  z.number().finite(),
  z.null(),
]);
const binding = z
  .record(z.string().min(1).max(64), scalar)
  .refine((value) => Object.keys(value).length <= 32);
export const lifecycleInvocationSchema = z
  .object({
    correlation: binding,
    id: lifecycleIdSchema,
    operation: z.enum(["up", "artifacts_export", "down"]),
    request_policy: binding,
    version: z.literal(LIFECYCLE_INVOCATION_VERSION),
  })
  .strict();
export type LifecycleInvocation = z.infer<typeof lifecycleInvocationSchema>;
export const lifecycleOwnerSchema = z
  .object({
    epoch: z.string().uuid(),
    lease_expires_at: z.number().int().positive(),
    pid: z.number().int().positive(),
    version: z.literal(LIFECYCLE_OWNER_VERSION),
  })
  .strict();
export type LifecycleOwner = z.infer<typeof lifecycleOwnerSchema>;
export const LIFECYCLE_HEARTBEAT_VERSION =
  "spawnfile.lifecycle-heartbeat.v1" as const;
export const lifecycleHeartbeatSchema = z
  .object({
    epoch: z.string().uuid(),
    lease_expires_at: z.number().int().positive(),
    version: z.literal(LIFECYCLE_HEARTBEAT_VERSION),
  })
  .strict();
export type LifecycleHeartbeat = z.infer<typeof lifecycleHeartbeatSchema>;
export interface LifecycleOwnerCapability {
  epoch: string;
  role: "initial" | "recovery";
}
export type LifecycleClaim =
  | { capability: LifecycleOwnerCapability; status: "owner" }
  | { status: "pending" | "replay" };
export const lifecycleAdmissionSchema = z
  .object({
    invocation: lifecycleInvocationSchema,
    owner: lifecycleOwnerSchema,
    version: z.literal(LIFECYCLE_ADMISSION_VERSION),
  })
  .strict();
export type LifecycleAdmission = z.infer<typeof lifecycleAdmissionSchema>;
export const lifecycleAmbiguousReasonSchema = z.enum([
  "reconciliation_ambiguous",
  "recovery_owner_died",
]);
export type LifecycleAmbiguousReason = z.infer<
  typeof lifecycleAmbiguousReasonSchema
>;
export const lifecycleAmbiguousSchema = z
  .object({
    invocation_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    reason_code: lifecycleAmbiguousReasonSchema,
    version: z.literal(LIFECYCLE_AMBIGUOUS_VERSION),
  })
  .strict();
export const lifecycleCompletionSchema = z
  .object({
    invocation: lifecycleInvocationSchema,
    outcome_bytes: z.string().min(1).max(LIFECYCLE_RECORD_MAX_BYTES),
    version: z.literal(LIFECYCLE_COMPLETION_VERSION),
  })
  .strict();
export type LifecycleCompletion = z.infer<typeof lifecycleCompletionSchema>;
export const lifecycleTerminalSchema = z.discriminatedUnion("status", [
  z
    .object({
      completion: lifecycleCompletionSchema,
      status: z.literal("completed"),
      version: z.literal(LIFECYCLE_TERMINAL_VERSION),
    })
    .strict(),
  z
    .object({
      ambiguous: lifecycleAmbiguousSchema,
      status: z.literal("ambiguous"),
      version: z.literal(LIFECYCLE_TERMINAL_VERSION),
    })
    .strict(),
]);
export type LifecycleTerminal = z.infer<typeof lifecycleTerminalSchema>;
export const lifecycleExportOutcomeSchema = z
  .object({
    deployment: z.string().min(1).max(128),
    failed_files: z.array(z.string().min(1).max(512)).max(10_000),
    index: z.unknown(),
    index_path: z.string().min(1).max(4096),
    missing_optional_files: z.array(z.string().min(1).max(512)).max(10_000),
  })
  .strict();
export type LifecycleLookup =
  | {
      invocation_id: string;
      status: "not_applied";
      version: typeof LIFECYCLE_LOOKUP_VERSION;
    }
  | {
      invocation_digest: string;
      operation: LifecycleInvocation["operation"];
      outcome_bytes: string;
      status: "completed";
      version: typeof LIFECYCLE_LOOKUP_VERSION;
    }
  | {
      invocation_digest: string;
      operation: LifecycleInvocation["operation"];
      status: "pending";
      version: typeof LIFECYCLE_LOOKUP_VERSION;
    }
  | {
      invocation_digest: string;
      operation: LifecycleInvocation["operation"];
      reason_code: LifecycleAmbiguousReason;
      status: "ambiguous";
      version: typeof LIFECYCLE_LOOKUP_VERSION;
    };
export const canonicalLifecycleJson = (value: unknown): string =>
  value === null || typeof value !== "object"
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? `[${value.map(canonicalLifecycleJson).join(",")}]`
      : `{${Object.keys(value as object)
          .sort()
          .map(
            (key) =>
              `${JSON.stringify(key)}:${canonicalLifecycleJson((value as Record<string, unknown>)[key])}`,
          )
          .join(",")}}`;
export const lifecycleDigest = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalLifecycleJson(value)).digest("hex")}`;
