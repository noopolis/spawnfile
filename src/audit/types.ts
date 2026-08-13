/**
 * B54 — spawnfile.audit.v1 contract types. This module is type-only (no
 * logic, no I/O): the schema constant plus the AuditCheck/AuditReport shapes
 * every other file in src/audit/ produces or consumes. See AGENTS.md for the
 * folder-wide "reports, never enforces" rule this contract exists to serve.
 */

/** Versioned schema identifier stamped on every generated report, mirroring the `noopolis.causal-event.v1` precedent (src/ledger/envelope.ts). */
export const SPAWNFILE_AUDIT_SCHEMA = "spawnfile.audit.v1" as const;

/**
 * The five ledger/runtime categories checks 1-6 are grounded in, plus
 * "provenance" for check 7 (`provenance.signed-report`). The frozen B54
 * packet's contract line only lists five category values; "provenance" is
 * added here to keep every check's `id` prefix equal to its `category`
 * (checks 1-6 already follow that pattern exactly), rather than
 * mis-bucketing check 7 under an unrelated category. See AGENTS.md
 * "Deviations from the frozen packet".
 */
export type AuditCheckCategory = "causal" | "container" | "control" | "memory" | "network" | "provenance";

export type AuditCheckStatus = "pass" | "fail" | "not_applicable";

export type AuditCheckSeverity = "critical" | "high" | "medium";

export interface AuditCheck {
  category: AuditCheckCategory;
  evidence: Record<string, unknown>;
  id: string;
  severity: AuditCheckSeverity;
  status: AuditCheckStatus;
}

export interface AuditSummary {
  failed: number;
  na: number;
  passed: number;
}

export interface AuditReport {
  checks: AuditCheck[];
  /** Diagnostic only — excluded from determinism comparisons (two otherwise-identical generator runs may differ only here). */
  generated_at: string;
  run_id: string | null;
  schema: typeof SPAWNFILE_AUDIT_SCHEMA;
  summary: AuditSummary;
}
