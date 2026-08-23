import { z } from "zod";

import {
  organizationReadinessSchema,
  parseOrganizationReadiness,
  type OrganizationReadiness
} from "./organizationReady.js";
import {
  ORGANIZATION_HANDOFF_VERSION,
  parseOrganizationHandoff,
  type OrganizationHandoff
} from "./organizationHandoffTypes.js";
import { assertOrdinaryJsonGraph, parseOpaqueTargetHandle, type OpaqueTargetHandle } from "../target/index.js";

/**
 * `spawnfile.up-receipt.v1` — the machine contract `spawnfile up --json` writes to stdout
 * (contracts.md's Spawnfile up-receipt registry row; Decision 21's Piece 4). It is thin by
 * design: enough for a non-Docker caller (simfile's sim harness, later its supervisor) to
 * drive lifecycle without touching Docker directly, per `contracts.md`'s rule that
 * "Simfile -> spawnfile only through documented CLI + versioned receipts".
 *
 * `compiled_schedule` is populated even though nothing consumes it yet — it freezes the
 * shape simfile's wake-diff (the expected-wake denominator oracle, see contracts.md's
 * `simfile.run-manifest.v1` field notes) will read from later, so the receipt shape does
 * not need to change again when that consumer lands.
 *
 * No credentials/tokens ever belong on this contract (contracts.md: "No credentials in
 * exchanged artifacts") — `moltnet_base_url` is a bare URL, never an auth header/token.
 */
export const UP_RECEIPT_VERSION = "spawnfile.up-receipt.v1" as const;

const readinessStateSchema = z.union([
  z.literal("running"),
  z.literal("exited"),
  z.literal("unknown")
]);

export type UpReceiptReadinessState = z.infer<typeof readinessStateSchema>;

const compiledScheduleEntrySchema = z
  .object({
    agent: z.string().min(1),
    cron: z.string().min(1)
  })
  .strict();

export type CompiledScheduleEntry = z.infer<typeof compiledScheduleEntrySchema>;

/**
 * `{agent, engine}` disclosure entry (Piece 5, Slice B): ground truth for the
 * run-manifest's `pinned-engine` field, so a `scripted` (or any non-default)
 * pi engine is visibly disclosed rather than an invisible test-only branch.
 * Derived in `buildUpReceipt` from the compiled report's
 * `container.runtime_instances[].engine_by_node_id`. Optional on the schema
 * so existing (pre-Piece-5) receipts without this field still validate.
 */
const compiledEngineEntrySchema = z
  .object({
    agent: z.string().min(1),
    engine: z.string().min(1)
  })
  .strict();

export type CompiledEngineEntry = z.infer<typeof compiledEngineEntrySchema>;

const publishedMoltnetReleaseIdentitySchema = z.object({
  architecture: z.union([z.literal("amd64"), z.literal("arm64")]),
  asset: z.string().regex(/^moltnet_linux_(amd64|arm64)\.tar\.gz$/u),
  asset_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  capabilities: z.tuple([z.literal("pi-bridge")]),
  release_version: z.string().regex(/^v?\d+\.\d+\.\d+(?:-\d+-g[a-f0-9]{7,40})?$/u),
  source_revision: z.string().regex(/^[a-f0-9]{40}$/u),
  version: z.literal("spawnfile.moltnet-release-identity.v1")
}).strict().superRefine((value, context) => {
  if (!value.asset.includes(`_${value.architecture}.`)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["asset"],
      message: "Moltnet asset architecture must match identity architecture"
    });
  }
  const describedRevision = value.release_version.match(/-g([a-f0-9]{7,40})$/u)?.[1];
  if (describedRevision && !value.source_revision.startsWith(describedRevision)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["source_revision"],
      message: "Moltnet release version must match source revision"
    });
  }
});

const localMoltnetReleaseIdentitySchema = z.object({
  architecture: z.union([z.literal("amd64"), z.literal("arm64")]),
  asset: z.string().regex(/^moltnet_linux_(amd64|arm64)\.tar\.gz$/u),
  asset_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  capabilities: z.tuple([z.literal("daimon-bridge"), z.literal("pi-bridge")]),
  development: z.object({
    mode: z.literal("local-development"),
    non_production: z.literal(true),
    unsigned: z.literal(true),
    unpublished: z.literal(true)
  }).strict(),
  source_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  version: z.literal("spawnfile.moltnet-release-identity.v1")
}).strict().superRefine((value, context) => {
  if (!value.asset.includes(`_${value.architecture}.`)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["asset"], message: "Moltnet asset architecture must match identity architecture" });
  }
});

const moltnetReleaseIdentitySchema = z.union([
  publishedMoltnetReleaseIdentitySchema,
  localMoltnetReleaseIdentitySchema
]);

export type MoltnetReleaseReceiptIdentity = z.infer<typeof moltnetReleaseIdentitySchema>;

const organizationHandoffReceiptSchema = z.object({
  binding_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  deployment_handle: z.string().regex(/^sf-oh1-[a-f0-9]{64}$/u),
  lifecycle_receipts: z.object({
    down: z.literal("spawnfile.down-receipt.v1"),
    export: z.literal("spawnfile.export-index.v1"),
    up: z.literal(UP_RECEIPT_VERSION)
  }).strict(),
  network_attachment_handle: z.string().regex(/^opaque_[a-z0-9]{16,64}$/u),
  run_id: z.string().min(1),
  selected_target_receipt_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  version: z.literal(ORGANIZATION_HANDOFF_VERSION)
}).strict().superRefine((value, context) => {
  try {
    parseOrganizationHandoff(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "invalid organization handoff" });
  }
});

const INVALID_JSON_GRAPH = Symbol("invalid-json-graph");

const upReceiptObjectSchema = z
  .object({
    version: z.literal(UP_RECEIPT_VERSION),
    run_id: z.string().min(1).nullable(),
    fingerprint: z.string().min(1),
    deployment: z
      .object({
        name: z.string().min(1).nullable(),
        container_ids: z.array(z.string().min(1))
      })
      .strict(),
    readiness: z
      .object({
        state: readinessStateSchema,
        moltnet_base_url: z.string().min(1).nullable()
      })
      .strict(),
    compiled_schedule: z.array(compiledScheduleEntrySchema),
    engines: z.array(compiledEngineEntrySchema).optional(),
    moltnet_release: moltnetReleaseIdentitySchema.optional(),
    organization_handoff: organizationHandoffReceiptSchema.optional(),
    organization_handoff_handle: z.string().optional(),
    organization_ready: organizationReadinessSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.organization_handoff && (value.run_id === null || value.run_id !== value.organization_handoff.run_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["organization_handoff", "run_id"],
        message: "organization handoff run_id must match receipt run_id"
      });
    }
    if (value.organization_handoff_handle !== undefined) {
      if (!value.organization_handoff) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["organization_handoff_handle"], message: "organization handoff handle requires organization handoff" });
      }
      try { parseOpaqueTargetHandle(value.organization_handoff_handle); } catch {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["organization_handoff_handle"], message: "invalid organization handoff handle" });
      }
    }
  });

export const upReceiptSchema = z
  .preprocess((value) => {
    try {
      assertOrdinaryJsonGraph(value);
      return value;
    } catch {
      return INVALID_JSON_GRAPH;
    }
  }, upReceiptObjectSchema);

export type UpReceipt = Omit<z.infer<typeof upReceiptSchema>, "organization_handoff" | "organization_handoff_handle" | "organization_ready"> & {
  organization_handoff?: OrganizationHandoff;
  organization_handoff_handle?: OpaqueTargetHandle;
  organization_ready?: OrganizationReadiness;
};

export const parseUpReceipt = (raw: unknown): UpReceipt => {
  try {
    assertOrdinaryJsonGraph(raw);
    const result = upReceiptSchema.safeParse(raw);
    if (!result.success) throw new TypeError();
    const {
      organization_handoff: handoff,
      organization_handoff_handle: handoffHandle,
      organization_ready: readiness,
      ...receipt
    } = result.data;
    return {
      ...receipt,
      ...(handoff ? { organization_handoff: parseOrganizationHandoff(handoff) } : {}),
      ...(handoffHandle ? { organization_handoff_handle: parseOpaqueTargetHandle(handoffHandle) } : {}),
      ...(readiness ? { organization_ready: parseOrganizationReadiness(readiness) } : {})
    };
  } catch {
    throw new Error(`invalid ${UP_RECEIPT_VERSION}`);
  }
};
