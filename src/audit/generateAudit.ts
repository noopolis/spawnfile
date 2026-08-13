import { readdir } from "node:fs/promises";
import path from "node:path";

import { fileExists, readUtf8File } from "../filesystem/index.js";
import type { CausalEvent, EmitterSpec, ExecResult } from "../ledger/index.js";
import { runRealConformance } from "../ledger/index.js";

import type { RunLedgerEvidence, StaticContainerEvidence } from "./checks.js";
import {
  checkContainerNoBakedSecrets,
  checkControlWakeFailClosed,
  checkDeniedLedgerVisible,
  checkMemoryCrossScopeCapability,
  checkNonMemberWriteDenied,
  checkPrincipalsAuthenticated,
  checkProvenanceSignedReport
} from "./checks.js";
import type { AuditCheck, AuditReport, AuditSummary } from "./types.js";
import { SPAWNFILE_AUDIT_SCHEMA } from "./types.js";

export interface GenerateAuditOptions {
  /** Required. The compiled-output directory (`spawnfile compile`'s emitted `Dockerfile`, `entrypoint.sh`, and — for a Pi-targeted compile — `runtime/app.mjs`). Static checks 3-4 always evaluate pass/fail against whatever is (or is not) present here; a missing file reads as an empty string, never a silent skip. */
  compiledOutputDirPath: string;
  /** Optional. A directory of `*.jsonl` ledger fixture files plus an optional `expected-denials.json` manifest (see checks.ts's `RunLedgerEvidence`). Omitting it (or an empty directory) is what makes run-mode checks 1, 2, 5, 6 report `not_applicable` — they never `pass` without it. */
  ledgerDirPath?: string;
  /** Injectable clock for `generated_at`, defaulting to `() => new Date()`. Every other report field is deterministic given the same inputs. */
  now?: () => Date;
  /** Secret env var NAMES this compile declared required (`requiredSecrets` passed to `renderEntrypoint`). Defaults to `[]`. */
  requiredSecrets?: string[];
}

interface ExpectedDenialsManifest {
  expectedDenialTypes?: unknown;
}

interface ExpectedDenialsResult {
  expectedDenialTypes: string[];
  /** Whether `expected-denials.json` actually exists in the ledger directory — distinct from `expectedDenialTypes` being empty, which is also true for a present-but-malformed/empty manifest. Check 2 (`checkDeniedLedgerVisible`) needs this to tell "no manifest at all" apart from "a manifest exists and asserts nothing". */
  manifestPresent: boolean;
}

const readOptionalFile = async (filePath: string): Promise<string> =>
  (await fileExists(filePath)) ? readUtf8File(filePath) : "";

const readExpectedDenials = async (ledgerDirPath: string): Promise<ExpectedDenialsResult> => {
  const manifestPath = path.join(ledgerDirPath, "expected-denials.json");
  if (!(await fileExists(manifestPath))) {
    return { expectedDenialTypes: [], manifestPresent: false };
  }

  const raw = await readUtf8File(manifestPath);
  const parsed = JSON.parse(raw) as ExpectedDenialsManifest;
  if (!Array.isArray(parsed.expectedDenialTypes)) {
    return { expectedDenialTypes: [], manifestPresent: true };
  }

  return {
    expectedDenialTypes: parsed.expectedDenialTypes.filter((value): value is string => typeof value === "string"),
    manifestPresent: true
  };
};

/**
 * Reads every `*.jsonl` file in `ledgerDirPath` and feeds it to
 * `runRealConformance` (src/ledger/conformance.ts) through an injected
 * `exec` that returns each file's pre-read text instead of spawning a real
 * sibling emitter process. This is what keeps the whole B54 generator
 * offline while still reusing `runRealConformance`'s real schema/seq/
 * payload-minimum/principal-grammar/chain-stitch pipeline rather than
 * reimplementing any of it — see src/ledger/emitters.ts for the `Exec`/
 * `EmitterSpec` contract this fills in. Returns `undefined` (never an empty
 * evidence object) when the directory has no `*.jsonl` files, so callers can
 * distinguish "no run artifacts" from "ledger with zero events".
 */
const collectRunLedgerEvidence = async (ledgerDirPath: string): Promise<RunLedgerEvidence | undefined> => {
  const entries = await readdir(ledgerDirPath, { withFileTypes: true }).catch(() => []);
  const jsonlFileNames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  if (jsonlFileNames.length === 0) {
    return undefined;
  }

  const contentByFileName = new Map<string, string>();
  for (const fileName of jsonlFileNames) {
    contentByFileName.set(fileName, await readUtf8File(path.join(ledgerDirPath, fileName)));
  }

  const specs: EmitterSpec[] = jsonlFileNames.map((fileName) => ({
    command: [fileName],
    cwd: ledgerDirPath,
    name: fileName.replace(/\.jsonl$/u, ""),
    output: "stdout-jsonl"
  }));

  // Offline exec: returns the pre-read fixture text for the named source,
  // never spawns a process. Matches src/ledger/emitters.ts's `Exec` contract.
  const exec = (spec: EmitterSpec): Promise<ExecResult> =>
    Promise.resolve({
      exitCode: 0,
      stderr: "",
      stdout: contentByFileName.get(`${spec.name}.jsonl`) ?? "",
      timedOut: false
    });

  const report = await runRealConformance({ exec, specs });
  const { expectedDenialTypes, manifestPresent } = await readExpectedDenials(ledgerDirPath);

  return {
    eventCount: report.eventCount,
    events: report.events,
    expectedDenialTypes,
    issues: report.issues,
    manifestPresent,
    sources: report.sourceCounts.map((entry) => entry.source)
  };
};

const collectStaticEvidence = async (
  compiledOutputDirPath: string,
  requiredSecrets: string[]
): Promise<StaticContainerEvidence> => ({
  dockerfile: await readOptionalFile(path.join(compiledOutputDirPath, "Dockerfile")),
  entrypoint: await readOptionalFile(path.join(compiledOutputDirPath, "entrypoint.sh")),
  piAppSource: await readOptionalFile(path.join(compiledOutputDirPath, "runtime", "app.mjs")),
  requiredSecrets
});

const summarize = (checks: AuditCheck[]): AuditSummary => ({
  failed: checks.filter((check) => check.status === "fail").length,
  na: checks.filter((check) => check.status === "not_applicable").length,
  passed: checks.filter((check) => check.status === "pass").length
});

/** `null` unless every ledger event shares one `run_id` (see specs/CAUSAL.md — a single audit always covers one run). */
const resolveRunId = (events: CausalEvent[]): string | null => {
  if (events.length === 0) {
    return null;
  }
  const runIds = new Set(events.map((event) => event.run_id));
  return runIds.size === 1 ? (runIds.values().next().value as string) : null;
};

/**
 * Orchestrator: the only I/O-performing function in src/audit/. Reads the
 * compiled-output directory and, if given, the ledger directory, then runs
 * the seven pure checks (checks.ts) and assembles the `AuditReport`.
 * Deterministic across repeated calls with the same inputs except for
 * `generated_at`.
 */
export const generateAudit = async (options: GenerateAuditOptions): Promise<AuditReport> => {
  const now = options.now ?? (() => new Date());
  const requiredSecrets = options.requiredSecrets ?? [];

  const [ledgerEvidence, staticEvidence] = await Promise.all([
    options.ledgerDirPath ? collectRunLedgerEvidence(options.ledgerDirPath) : Promise.resolve(undefined),
    collectStaticEvidence(options.compiledOutputDirPath, requiredSecrets)
  ]);

  const checks: AuditCheck[] = [
    checkPrincipalsAuthenticated(ledgerEvidence),
    checkDeniedLedgerVisible(ledgerEvidence),
    checkControlWakeFailClosed(staticEvidence),
    checkContainerNoBakedSecrets(staticEvidence),
    checkMemoryCrossScopeCapability(ledgerEvidence),
    checkNonMemberWriteDenied(ledgerEvidence),
    checkProvenanceSignedReport()
  ];

  return {
    checks,
    generated_at: now().toISOString(),
    run_id: ledgerEvidence ? resolveRunId(ledgerEvidence.events) : null,
    schema: SPAWNFILE_AUDIT_SCHEMA,
    summary: summarize(checks)
  };
};
