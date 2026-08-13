/**
 * Evidence input types and small pure helpers shared by every check function
 * in checks.ts. Split out purely to keep checks.ts under the repo's 400-line
 * cap (see /Users/apresmoi/Documents/spawnfile/CLAUDE.md) — nothing here is
 * a different layer or a different contract, it is checks.ts's own
 * plumbing. No I/O, same as checks.ts itself.
 */
import type { CausalEvent, ConformanceIssue } from "../ledger/index.js";
import { DEFAULT_PAYLOAD_MINIMUMS } from "../ledger/index.js";

import type { AuditCheck, AuditCheckCategory, AuditCheckSeverity, AuditCheckStatus } from "./types.js";

/**
 * Ledger evidence handed to every run-mode check (1, 2, 5, 6). Built once by
 * `generateAudit.ts` from `runRealConformance` (offline-mode: an injected
 * `exec` that reads fixture files instead of spawning a sibling process —
 * see generateAudit.ts) plus the audit's own `expected-denials.json`
 * manifest. `undefined` means "no run artifacts provided" — every run-mode
 * check below returns `not_applicable` in that case, and never `pass`.
 */
export interface RunLedgerEvidence {
  eventCount: number;
  events: CausalEvent[];
  /** Denial types this fixture's `expected-denials.json` asserts a `*.denied` event must exist for (silent-drop detection, check 2). */
  expectedDenialTypes: string[];
  /** Every schema/seq/payload-minimum/principal-grammar/chain-stitch issue `runRealConformance` reported — reused, never recomputed. */
  issues: ConformanceIssue[];
  /** Whether the ledger directory actually contained an `expected-denials.json` file — distinct from `expectedDenialTypes.length === 0`, which is also true for a *present-but-empty* manifest. Check 2 uses this to tell "no manifest, so silent-drop cannot be assessed" apart from "a manifest exists and asserts nothing". */
  manifestPresent: boolean;
  sources: string[];
}

/**
 * Compiled-output evidence handed to every static check (3, 4). Plain
 * strings, not paths — `generateAudit.ts` owns the file reads, these
 * functions stay pure. Any file that does not exist in the compiled output
 * directory reads as an empty string; that is itself audit-worthy (absence
 * of proof is not proof of enforcement), never treated as not_applicable —
 * unlike run-mode checks, the compiled-output directory is a required
 * `generateAudit` input, never optional.
 */
export interface StaticContainerEvidence {
  /** Rendered Dockerfile text (containerArtifactsRender.ts's `renderDockerfile` output shape). */
  dockerfile: string;
  /** Rendered entrypoint.sh text (containerEntrypointRender.ts's `renderEntrypoint` output shape). */
  entrypoint: string;
  /** Rendered generated Pi app source, if this compile targeted Pi (appControlSource.ts's `renderPiControlSource` output is inlined into it). Empty string if the compiled output has no such file. */
  piAppSource: string;
  /** Secret env var NAMES this compile declared required (containerEntrypointRender.ts's `renderEntrypoint(runtimePlans, requiredSecrets, ...)` second argument) — never the values. */
  requiredSecrets: string[];
}

export const notApplicable = (
  id: string,
  category: AuditCheckCategory,
  severity: AuditCheckSeverity,
  reason: string
): AuditCheck => ({
  category,
  evidence: { reason },
  id,
  severity,
  status: "not_applicable"
});

export const statusFor = (ok: boolean): AuditCheckStatus => (ok ? "pass" : "fail");

/** `conformance.ts`'s `checkPayloadMinimums` is not exported (it is that module's private helper); this is the same one-line key-presence rule applied directly to already-parsed events, not a reimplementation of `validateConformanceSources`'s schema/seq/stitch pipeline. */
export const missingRequiredKeys = (event: CausalEvent, requiredKeys: string[]): string[] =>
  requiredKeys.filter((key) => !(key in event.payload) || event.payload[key] === undefined);

export const DENIAL_MINIMUMS_BY_TYPE = new Map(
  DEFAULT_PAYLOAD_MINIMUMS.filter((minimum) => minimum.type.endsWith(".denied")).map((minimum) => [
    minimum.type,
    minimum.requiredKeys
  ])
);

/** Env name gating the operator-only wake endpoint (appControlSource.ts:45, `CONTROL_TOKEN_ENV`). */
export const CONTROL_TOKEN_ENV = "SPAWNFILE_PI_CONTROL_TOKEN";
/**
 * Verbatim source-text substring of appControlSource.ts:75's fail-closed
 * rejection branch (`return { ok: false, reason: "no operator token
 * configured (" + CONTROL_TOKEN_ENV + " is unset)" }`). The literal string
 * checked here is only the first concatenated chunk — the source
 * concatenates `CONTROL_TOKEN_ENV` in with `+`, so the fully-assembled
 * runtime message never appears as one literal in the source text itself.
 * Its presence is direct evidence the fail-closed branch was actually
 * emitted, not paraphrased.
 */
export const FAIL_CLOSED_MARKER = "no operator token configured (";

export const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * Matches a literal (non-`$`-expansion) shell/Dockerfile assignment
 * `NAME=<value>` — never a `require_env 'NAME'` call (no `=` follows the
 * name there at all) and never a same-name passthrough reference like
 * `NAME="$NAME"`/`NAME=${NAME}` (an optional quote followed by `$`), both of
 * which read the env rather than bake a value into it.
 */
export const literalAssignmentPattern = (name: string): RegExp =>
  new RegExp(`\\b${escapeRegExp(name)}=(?!['"]?\\$)\\S`, "u");
