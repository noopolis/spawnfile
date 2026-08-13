import { z } from "zod";

import type { AuditReport } from "./types.js";
import { SPAWNFILE_AUDIT_SCHEMA } from "./types.js";

/**
 * Pure reader/validator for an existing `spawnfile.audit.v1` report — the
 * `envelope.ts` precedent (a zod schema mirroring the hand-written
 * `AuditReport` interface, plus a `parse*`/`validate*` pair). No I/O:
 * callers pass already-read JSON (typically `JSON.parse`d from a file
 * `generateAudit.ts` wrote), this module only checks shape.
 */

const auditCheckSchema = z
  .object({
    category: z.enum(["causal", "container", "control", "memory", "network", "provenance"]),
    evidence: z.record(z.string(), z.unknown()),
    id: z.string().min(1),
    severity: z.enum(["critical", "high", "medium"]),
    status: z.enum(["pass", "fail", "not_applicable"])
  })
  .strict();

const auditSummarySchema = z
  .object({
    failed: z.number().int().min(0),
    na: z.number().int().min(0),
    passed: z.number().int().min(0)
  })
  .strict();

export const auditReportSchema = z
  .object({
    checks: z.array(auditCheckSchema),
    generated_at: z.string().min(1),
    run_id: z.string().min(1).nullable(),
    schema: z.literal(SPAWNFILE_AUDIT_SCHEMA),
    summary: auditSummarySchema
  })
  .strict();

export interface AuditReadError {
  message: string;
}

/**
 * Safe (non-throwing) validator. Rejects an unknown `schema` string as a
 * top-level structural mismatch — `z.literal` already fails it — rather
 * than accepting any string and comparing separately, so a caller cannot
 * bypass the schema gate with a structurally-valid-but-wrong-version report.
 */
export const validateAuditReport = (
  value: unknown
): { report: AuditReport } | { error: AuditReadError } => {
  const result = auditReportSchema.safeParse(value);
  if (!result.success) {
    return {
      error: {
        message: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
      }
    };
  }

  return { report: result.data as AuditReport };
};

/** Throwing counterpart of `validateAuditReport`, mirroring `envelope.ts`'s `parseCausalEvent`. */
export const readAuditReport = (value: unknown): AuditReport => {
  const result = validateAuditReport(value);
  if ("error" in result) {
    throw new Error(`invalid spawnfile.audit.v1 report: ${result.error.message}`);
  }
  return result.report;
};
