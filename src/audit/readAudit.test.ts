import { describe, expect, it } from "vitest";

import type { AuditReport } from "./types.js";
import { SPAWNFILE_AUDIT_SCHEMA } from "./types.js";

import { readAuditReport, validateAuditReport } from "./readAudit.js";

const validReport: AuditReport = {
  checks: [
    {
      category: "causal",
      evidence: { eventCount: 3 },
      id: "causal.principals-authenticated",
      severity: "critical",
      status: "pass"
    },
    {
      category: "provenance",
      evidence: { reason: "not yet enforced (see B66)" },
      id: "provenance.signed-report",
      severity: "medium",
      status: "not_applicable"
    }
  ],
  generated_at: "2026-07-01T00:00:00.000Z",
  run_id: "b92-conformance",
  schema: SPAWNFILE_AUDIT_SCHEMA,
  summary: { failed: 0, na: 1, passed: 1 }
};

describe("readAuditReport", () => {
  it("round-trips a valid report through JSON serialization unchanged", () => {
    const roundTripped = readAuditReport(JSON.parse(JSON.stringify(validReport)));
    expect(roundTripped).toEqual(validReport);
  });

  it("accepts a null run_id (no ledger artifacts were provided)", () => {
    const report = { ...validReport, run_id: null };
    expect(readAuditReport(report)).toEqual(report);
  });

  it("rejects an unknown schema string", () => {
    const report = { ...validReport, schema: "spawnfile.audit.v2" };
    expect(() => readAuditReport(report)).toThrow(/invalid spawnfile\.audit\.v1 report/);
  });

  it("rejects a report missing a required top-level field", () => {
    const { summary: _summary, ...withoutSummary } = validReport;
    expect(() => readAuditReport(withoutSummary)).toThrow();
  });

  it("rejects a check with an unknown status", () => {
    const report = {
      ...validReport,
      checks: [{ ...validReport.checks[0], status: "unknown" }]
    };
    expect(() => readAuditReport(report)).toThrow();
  });

  it("rejects a report with an unrecognized additional top-level property", () => {
    expect(() => readAuditReport({ ...validReport, signature: "not-yet-supported" })).toThrow();
  });
});

describe("validateAuditReport", () => {
  it("returns { report } for a valid input", () => {
    const result = validateAuditReport(validReport);
    expect("report" in result).toBe(true);
  });

  it("returns { error } (never throws) for an invalid input", () => {
    const result = validateAuditReport({ not: "a report" });
    expect("error" in result).toBe(true);
  });
});
