import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { generateAudit } from "./generateAudit.js";
import { readAuditReport } from "./readAudit.js";
import type { AuditReport } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string): string => path.join(__dirname, "fixtures", name);

const REQUIRED_SECRETS = ["OPENAI_API_KEY"];

/**
 * Minimal structural JSON Schema validator — draft-07 subset sufficient for
 * schema.json's own shape (type/properties/required/additionalProperties/
 * enum/const/items/$ref into `definitions`). Not a general-purpose
 * validator; good enough to prove `generateAudit`'s output actually
 * conforms to the shipped schema.json without adding an ajv dependency.
 */
const validateAgainstSchema = (schema: Record<string, unknown>, root: Record<string, unknown>, value: unknown): string[] => {
  const resolve = (node: Record<string, unknown>): Record<string, unknown> => {
    if (typeof node.$ref === "string") {
      const key = node.$ref.replace("#/definitions/", "");
      return (root.definitions as Record<string, unknown>)[key] as Record<string, unknown>;
    }
    return node;
  };

  const walk = (node: Record<string, unknown>, target: unknown, at: string): string[] => {
    const resolved = resolve(node);
    const errors: string[] = [];

    if (resolved.const !== undefined && target !== resolved.const) {
      errors.push(`${at}: expected const ${JSON.stringify(resolved.const)}, got ${JSON.stringify(target)}`);
    }
    if (Array.isArray(resolved.enum) && !resolved.enum.includes(target)) {
      errors.push(`${at}: ${JSON.stringify(target)} not in enum ${JSON.stringify(resolved.enum)}`);
    }

    const types = Array.isArray(resolved.type) ? resolved.type : resolved.type ? [resolved.type] : [];
    if (types.length > 0) {
      const actual = target === null ? "null" : Array.isArray(target) ? "array" : typeof target;
      const normalized = actual === "number" && Number.isInteger(target) ? ["number", "integer"] : [actual];
      if (!types.some((type) => normalized.includes(type as string))) {
        errors.push(`${at}: expected type ${JSON.stringify(types)}, got ${actual}`);
      }
    }

    if (resolved.type === "object" && target !== null && typeof target === "object" && !Array.isArray(target)) {
      const obj = target as Record<string, unknown>;
      for (const requiredKey of (resolved.required as string[] | undefined) ?? []) {
        if (!(requiredKey in obj)) {
          errors.push(`${at}: missing required property "${requiredKey}"`);
        }
      }
      const properties = (resolved.properties as Record<string, unknown> | undefined) ?? {};
      if (resolved.additionalProperties === false) {
        for (const key of Object.keys(obj)) {
          if (!(key in properties)) {
            errors.push(`${at}: unexpected additional property "${key}"`);
          }
        }
      }
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (key in obj) {
          errors.push(...walk(propertySchema as Record<string, unknown>, obj[key], `${at}.${key}`));
        }
      }
    }

    if (resolved.type === "array" && Array.isArray(target) && resolved.items) {
      target.forEach((item, index) => {
        errors.push(...walk(resolved.items as Record<string, unknown>, item, `${at}[${index}]`));
      });
    }

    return errors;
  };

  return walk(schema, value, "$");
};

describe("generateAudit — good fixture", () => {
  it("passes checks 1-6 and leaves check 7 not_applicable", async () => {
    const report = await generateAudit({
      compiledOutputDirPath: fixturePath("good"),
      ledgerDirPath: fixturePath("good"),
      requiredSecrets: REQUIRED_SECRETS
    });

    const statusById = new Map(report.checks.map((check) => [check.id, check.status]));
    expect(statusById.get("causal.principals-authenticated")).toBe("pass");
    expect(statusById.get("causal.denied-ledger-visible")).toBe("pass");
    expect(statusById.get("control.wake-fail-closed")).toBe("pass");
    expect(statusById.get("container.no-baked-secrets")).toBe("pass");
    expect(statusById.get("memory.cross-scope-capability")).toBe("pass");
    expect(statusById.get("network.non-member-write-denied")).toBe("pass");
    expect(statusById.get("provenance.signed-report")).toBe("not_applicable");

    // The good fixture's checks 5/6 passes must be grounded in a real,
    // observed denial event — never the vacuous "zero events" pass the
    // defect fix removed.
    const memoryCheck = report.checks.find((entry) => entry.id === "memory.cross-scope-capability");
    expect(memoryCheck?.evidence).toMatchObject({ deniedEventCount: 1, malformed: [] });
    const networkCheck = report.checks.find((entry) => entry.id === "network.non-member-write-denied");
    expect(networkCheck?.evidence).toMatchObject({ deniedEventCount: 1, malformed: [] });
  });

  it("computes a summary matching the actual per-check statuses", async () => {
    const report = await generateAudit({
      compiledOutputDirPath: fixturePath("good"),
      ledgerDirPath: fixturePath("good"),
      requiredSecrets: REQUIRED_SECRETS
    });

    expect(report.summary).toEqual({
      failed: report.checks.filter((check) => check.status === "fail").length,
      na: report.checks.filter((check) => check.status === "not_applicable").length,
      passed: report.checks.filter((check) => check.status === "pass").length
    });
    expect(report.summary).toEqual({ failed: 0, na: 1, passed: 6 });
  });

  it("is byte-identical across two runs modulo generated_at", async () => {
    const options = {
      compiledOutputDirPath: fixturePath("good"),
      ledgerDirPath: fixturePath("good"),
      requiredSecrets: REQUIRED_SECRETS
    };
    const first = await generateAudit(options);
    const second = await generateAudit(options);

    const strip = (report: AuditReport): Omit<AuditReport, "generated_at"> => {
      const { generated_at: _generatedAt, ...rest } = report;
      return rest;
    };

    expect(strip(first)).toEqual(strip(second));
    expect(first.generated_at).not.toBe(""); // sanity: the excluded field is actually populated
  });

  it("validates against the shipped schema.json", async () => {
    const schemaModule = await import("./schema.json", { with: { type: "json" } });
    const schema = schemaModule.default as Record<string, unknown>;
    const report = await generateAudit({
      compiledOutputDirPath: fixturePath("good"),
      ledgerDirPath: fixturePath("good"),
      requiredSecrets: REQUIRED_SECRETS
    });

    const errors = validateAgainstSchema(schema, schema, report);
    expect(errors).toEqual([]);
  });

  it("no check ever reports pass for the unenforced provenance property", async () => {
    const reports = await Promise.all(
      ["good", "broken-anonymous", "broken-silent-drop"].map((name) =>
        generateAudit({
          compiledOutputDirPath: fixturePath(name),
          ledgerDirPath: fixturePath(name),
          requiredSecrets: REQUIRED_SECRETS
        })
      )
    );
    for (const report of reports) {
      const provenanceCheck = report.checks.find((check) => check.id === "provenance.signed-report");
      expect(provenanceCheck?.status).toBe("not_applicable");
    }
  });
});

describe("generateAudit — broken-anonymous fixture", () => {
  it("flips causal.principals-authenticated to fail with the offending principal in evidence", async () => {
    const report = await generateAudit({
      compiledOutputDirPath: fixturePath("broken-anonymous"),
      ledgerDirPath: fixturePath("broken-anonymous"),
      requiredSecrets: REQUIRED_SECRETS
    });

    const check = report.checks.find((entry) => entry.id === "causal.principals-authenticated");
    expect(check?.status).toBe("fail");
    expect(check?.evidence.offendingPrincipals).toEqual([
      { event_id: "moltnet:m1", principal_id: "system:moltnet.anonymous" }
    ]);
  });
});

describe("generateAudit — broken-silent-drop fixture", () => {
  it("flips causal.denied-ledger-visible to fail while leaving other run checks unaffected", async () => {
    const report = await generateAudit({
      compiledOutputDirPath: fixturePath("broken-silent-drop"),
      ledgerDirPath: fixturePath("broken-silent-drop"),
      requiredSecrets: REQUIRED_SECRETS
    });

    const statusById = new Map(report.checks.map((check) => [check.id, check.status]));
    expect(statusById.get("causal.denied-ledger-visible")).toBe("fail");
    expect(statusById.get("causal.principals-authenticated")).toBe("pass");
    expect(statusById.get("memory.cross-scope-capability")).toBe("pass");

    const check = report.checks.find((entry) => entry.id === "causal.denied-ledger-visible");
    expect(check?.evidence.silentlyDropped).toEqual(["message.denied"]);
  });

  it("no longer rubber-stamps network.non-member-write-denied as pass — this fixture has zero message.denied events, so it must be not_applicable", async () => {
    // This is the exact defect B54's adversarial verification found: this
    // fixture's whole point is that moltnet's denial was silently dropped
    // (check 2 fails on it), yet the old `malformed.length === 0` vacuous
    // rule made check 6 report a green `pass` with deniedEventCount:0 —
    // rubber-stamping the very silent drop check 2 flags. It must now be
    // not_applicable, never pass, whenever no message.denied event exists.
    const report = await generateAudit({
      compiledOutputDirPath: fixturePath("broken-silent-drop"),
      ledgerDirPath: fixturePath("broken-silent-drop"),
      requiredSecrets: REQUIRED_SECRETS
    });

    const check = report.checks.find((entry) => entry.id === "network.non-member-write-denied");
    expect(check?.status).toBe("not_applicable");
    expect(check?.evidence).toMatchObject({ deniedEventCount: 0 });
  });
});

describe("generateAudit — no ledger directory", () => {
  it("emits not_applicable (never pass) for every run-mode check", async () => {
    const report = await generateAudit({
      compiledOutputDirPath: fixturePath("good"),
      requiredSecrets: REQUIRED_SECRETS
    });

    const runCheckIds = [
      "causal.principals-authenticated",
      "causal.denied-ledger-visible",
      "memory.cross-scope-capability",
      "network.non-member-write-denied"
    ];
    for (const id of runCheckIds) {
      const check = report.checks.find((entry) => entry.id === id);
      expect(check?.status).toBe("not_applicable");
      expect(check?.evidence).toEqual({ reason: "no run artifacts provided" });
    }
    expect(report.run_id).toBeNull();
  });

  it("also emits not_applicable when a ledgerDirPath is given but contains no *.jsonl files", async () => {
    // fixtures/good/runtime/ only holds app.mjs — no ledger jsonl at all, a
    // different code path than omitting ledgerDirPath entirely.
    const report = await generateAudit({
      compiledOutputDirPath: fixturePath("good"),
      ledgerDirPath: path.join(fixturePath("good"), "runtime"),
      requiredSecrets: REQUIRED_SECRETS
    });

    const check = report.checks.find((entry) => entry.id === "causal.principals-authenticated");
    expect(check?.status).toBe("not_applicable");
    expect(report.run_id).toBeNull();
  });

  it("reports a null run_id (not a crash) for a *.jsonl file present but empty", async () => {
    const ledgerDir = await mkdtemp(path.join(tmpdir(), "spawnfile-audit-empty-ledger-"));
    try {
      await writeFile(path.join(ledgerDir, "ledger.jsonl"), "");

      const report = await generateAudit({
        compiledOutputDirPath: fixturePath("good"),
        ledgerDirPath: ledgerDir,
        requiredSecrets: REQUIRED_SECRETS
      });

      expect(report.run_id).toBeNull();
      const check = report.checks.find((entry) => entry.id === "causal.principals-authenticated");
      // A *.jsonl file was present (unlike the "no ledger" cases above), so
      // this is a genuine fail over zero events (runRealConformance's chain
      // stitch reports every chain role missing), never not_applicable.
      expect(check?.status).toBe("fail");
      expect(check?.evidence).toMatchObject({ eventCount: 0 });

      // Zero events also means zero denial events and no expected-denials
      // manifest: checks 2, 5, 6 must report not_applicable, never pass —
      // an unparseable/empty ledger earns no green security checks.
      const statusById = new Map(report.checks.map((entry) => [entry.id, entry.status]));
      expect(statusById.get("causal.denied-ledger-visible")).toBe("not_applicable");
      expect(statusById.get("memory.cross-scope-capability")).toBe("not_applicable");
      expect(statusById.get("network.non-member-write-denied")).toBe("not_applicable");
    } finally {
      await rm(ledgerDir, { recursive: true, force: true });
    }
  });

  it("reports checks 2/5/6 not_applicable and check 1 fail for a ledger whose only line is malformed (whole source drops to zero parsed events)", async () => {
    const ledgerDir = await mkdtemp(path.join(tmpdir(), "spawnfile-audit-malformed-line-"));
    try {
      await writeFile(path.join(ledgerDir, "ledger.jsonl"), "{not valid json\n");

      const report = await generateAudit({
        compiledOutputDirPath: fixturePath("good"),
        ledgerDirPath: ledgerDir,
        requiredSecrets: REQUIRED_SECRETS
      });

      const statusById = new Map(report.checks.map((entry) => [entry.id, entry.status]));
      // A broken/unparseable ledger must never print a green security
      // check: check 1 fails on the parse issue, and checks 2/5/6 have
      // nothing to observe, so they are not_applicable rather than a
      // vacuous pass.
      expect(statusById.get("causal.principals-authenticated")).toBe("fail");
      expect(statusById.get("causal.denied-ledger-visible")).toBe("not_applicable");
      expect(statusById.get("memory.cross-scope-capability")).toBe("not_applicable");
      expect(statusById.get("network.non-member-write-denied")).toBe("not_applicable");
    } finally {
      await rm(ledgerDir, { recursive: true, force: true });
    }
  });

  it("treats a malformed expected-denials.json (no expectedDenialTypes array) as no assertions", async () => {
    const ledgerDir = await mkdtemp(path.join(tmpdir(), "spawnfile-audit-malformed-manifest-"));
    try {
      await writeFile(path.join(ledgerDir, "ledger.jsonl"), "");
      await writeFile(path.join(ledgerDir, "expected-denials.json"), JSON.stringify({ notTheRightKey: true }));

      const report = await generateAudit({
        compiledOutputDirPath: fixturePath("good"),
        ledgerDirPath: ledgerDir,
        requiredSecrets: REQUIRED_SECRETS
      });

      const check = report.checks.find((entry) => entry.id === "causal.denied-ledger-visible");
      expect(check?.evidence).toMatchObject({ expectedDenialTypes: [] });
    } finally {
      await rm(ledgerDir, { recursive: true, force: true });
    }
  });
});

describe("generateAudit output round-trips through readAudit", () => {
  it("readAuditReport accepts a freshly generated report unchanged", async () => {
    const report = await generateAudit({
      compiledOutputDirPath: fixturePath("good"),
      ledgerDirPath: fixturePath("good"),
      requiredSecrets: REQUIRED_SECRETS
    });
    const roundTripped = readAuditReport(JSON.parse(JSON.stringify(report)));
    expect(roundTripped).toEqual(report);
  });
});
