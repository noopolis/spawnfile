// Not re-exported by src/ledger/index.js's barrel (see conformance.ts, which
// also imports it directly from principal.js rather than through the
// barrel); mirrored here for the same reason.
import { isAuthenticatedPrincipal } from "../ledger/principal.js";

import type { RunLedgerEvidence, StaticContainerEvidence } from "./checksShared.js";
import {
  CONTROL_TOKEN_ENV,
  DENIAL_MINIMUMS_BY_TYPE,
  escapeRegExp,
  FAIL_CLOSED_MARKER,
  literalAssignmentPattern,
  missingRequiredKeys,
  notApplicable,
  statusFor
} from "./checksShared.js";
import type { AuditCheck, AuditCheckCategory, AuditCheckSeverity } from "./types.js";

// Evidence input types (RunLedgerEvidence, StaticContainerEvidence) live in
// checksShared.ts, re-exported here so every existing `./checks.js` import
// site (generateAudit.ts, checks.test.ts) keeps working unchanged.
export type { RunLedgerEvidence, StaticContainerEvidence } from "./checksShared.js";

/**
 * Check 1 — `causal.principals-authenticated` (run). Grounded in
 * `runRealConformance` reporting zero issues over the ledger jsonl, and in
 * `isAuthenticatedPrincipal` (src/ledger/principal.ts:87) rejecting a bare,
 * literal-`anonymous`, or `system:moltnet.anonymous` principal
 * (principal.ts:45,93). Fails on either a nonempty `issues` list (any
 * schema/seq/payload/principal/chain problem `runRealConformance` found) or
 * an event whose `principal_id` is not authenticated — evidence names the
 * offending event and principal directly rather than relying on issue-
 * message string matching.
 */
export const checkPrincipalsAuthenticated = (evidence: RunLedgerEvidence | undefined): AuditCheck => {
  const id = "causal.principals-authenticated";
  const category: AuditCheckCategory = "causal";
  const severity: AuditCheckSeverity = "critical";

  if (!evidence) {
    return notApplicable(id, category, severity, "no run artifacts provided");
  }

  const offendingPrincipals = evidence.events
    .filter((event) => !isAuthenticatedPrincipal(event.principal_id))
    .map((event) => ({ event_id: event.event_id, principal_id: event.principal_id }));

  return {
    category,
    evidence: {
      eventCount: evidence.eventCount,
      issueCount: evidence.issues.length,
      offendingPrincipals,
      sources: evidence.sources
    },
    id,
    severity,
    status: statusFor(evidence.issues.length === 0 && offendingPrincipals.length === 0)
  };
};

/**
 * Check 2 — `causal.denied-ledger-visible` (run). Grounded in
 * `DEFAULT_PAYLOAD_MINIMUMS` (conformance.ts:67-69) for every `*.denied`
 * type: any such event that appears must carry its required keys. Also
 * detects a silent drop — this fixture's `expected-denials.json` asserted a
 * denial type occurred, but no matching `*.denied` event exists in the
 * ledger — which fails even when every event that *is* present is well
 * shaped.
 *
 * `not_applicable`, never `pass`, when there is no `expected-denials.json`
 * manifest AND zero `*.denied` events are present in the ledger — with
 * neither an assertion to check against nor an event to inspect, there is
 * nothing here to actually assess (see AGENTS.md's cardinal rule: absent
 * evidence is `not_applicable`, never `pass`). A manifest being present is
 * enough to keep evaluating (silent-drop detection needs no observed event
 * to fire), and any `*.denied` event that *is* present is always
 * key-validated regardless of manifest presence.
 */
export const checkDeniedLedgerVisible = (evidence: RunLedgerEvidence | undefined): AuditCheck => {
  const id = "causal.denied-ledger-visible";
  const category: AuditCheckCategory = "causal";
  const severity: AuditCheckSeverity = "high";

  if (!evidence) {
    return notApplicable(id, category, severity, "no run artifacts provided");
  }

  const presentDenials = evidence.events.filter((event) => DENIAL_MINIMUMS_BY_TYPE.has(event.type));

  if (!evidence.manifestPresent && presentDenials.length === 0) {
    return notApplicable(
      id,
      category,
      severity,
      "no denial events and no expected-denials manifest; cannot assess silent-drop"
    );
  }

  const malformed = presentDenials
    .map((event) => ({
      event_id: event.event_id,
      /* v8 ignore next -- presentDenials already filtered by DENIAL_MINIMUMS_BY_TYPE.has(event.type), so .get() always hits; defensive fallback only */
      missingKeys: missingRequiredKeys(event, DENIAL_MINIMUMS_BY_TYPE.get(event.type) ?? []),
      type: event.type
    }))
    .filter((entry) => entry.missingKeys.length > 0);

  const presentTypes = new Set(presentDenials.map((event) => event.type));
  const silentlyDropped = evidence.expectedDenialTypes.filter((type) => !presentTypes.has(type));

  return {
    category,
    evidence: {
      deniedEventCount: presentDenials.length,
      expectedDenialTypes: evidence.expectedDenialTypes,
      malformed,
      silentlyDropped
    },
    id,
    severity,
    status: statusFor(malformed.length === 0 && silentlyDropped.length === 0)
  };
};

/**
 * Check 3 — `control.wake-fail-closed` (static). Grounded in
 * appControlSource.ts:31-47 (B62 Option B): the operator wake endpoint must
 * fail closed when `SPAWNFILE_PI_CONTROL_TOKEN` is unset, never treat an
 * unset token as "auth disabled". Passes only when the compiled Pi app
 * source references the token env, contains the verbatim fail-closed
 * rejection text, and never bakes a literal default value for it.
 */
export const checkControlWakeFailClosed = (evidence: StaticContainerEvidence): AuditCheck => {
  const combined = `${evidence.dockerfile}\n${evidence.entrypoint}\n${evidence.piAppSource}`;
  const tokenReferenced = combined.includes(CONTROL_TOKEN_ENV);
  const failClosedMarkerFound = evidence.piAppSource.includes(FAIL_CLOSED_MARKER);
  const bakedDefaultFound = literalAssignmentPattern(CONTROL_TOKEN_ENV).test(combined);

  return {
    category: "control",
    evidence: {
      bakedDefaultFound,
      envSourceList: [CONTROL_TOKEN_ENV],
      failClosedMarkerFound,
      tokenReferenced
    },
    id: "control.wake-fail-closed",
    severity: "critical",
    status: statusFor(tokenReferenced && failClosedMarkerFound && !bakedDefaultFound)
  };
};

/**
 * Check 4 — `container.no-baked-secrets` (static). Grounded in
 * containerEntrypointRender.ts:232-233: every required secret is emitted as
 * a `require_env <name>` runtime check, never a literal value baked into the
 * Dockerfile build layer or the entrypoint script. Passes only when every
 * `requiredSecrets` name is `require_env`-guarded in the entrypoint AND no
 * name is ever followed by a literal (non-`$`) assignment anywhere in the
 * compiled Dockerfile/entrypoint text.
 */
export const checkContainerNoBakedSecrets = (evidence: StaticContainerEvidence): AuditCheck => {
  const combined = `${evidence.dockerfile}\n${evidence.entrypoint}`;

  const missingRequireEnv = evidence.requiredSecrets.filter(
    (name) => !new RegExp(`require_env\\s+['"]${escapeRegExp(name)}['"]`, "u").test(evidence.entrypoint)
  );
  const bakedLiteralValues = evidence.requiredSecrets.filter((name) => literalAssignmentPattern(name).test(combined));

  return {
    category: "container",
    evidence: {
      bakedLiteralValues,
      missingRequireEnv,
      requiredSecrets: evidence.requiredSecrets
    },
    id: "container.no-baked-secrets",
    severity: "critical",
    status: statusFor(missingRequireEnv.length === 0 && bakedLiteralValues.length === 0)
  };
};

/**
 * Check 5 — `memory.cross-scope-capability` (run). Grounded in mneme's
 * `mneme.cap.system.v1` foreign-scope escalation capability
 * (ecosystem/mneme/src/policy/capability.ts:28) and the
 * `memory.write.denied` payload minimum (conformance.ts:68:
 * `requested_scope`, `reason`). `mneme.cap.system.v1` is carried as an
 * informational `grounding` string only — this function performs no static
 * check against mneme's source, so the status is never driven by that
 * literal.
 *
 * `not_applicable`, never `pass`, when no `memory.write.denied` event is
 * present in the ledger: enforcement was never exercised in this run, and
 * "nothing to violate" is not evidence the capability guard works (see
 * AGENTS.md). When one or more denial events are present, every one must
 * carry both `requested_scope` and `reason` to pass.
 */
export const checkMemoryCrossScopeCapability = (evidence: RunLedgerEvidence | undefined): AuditCheck => {
  const id = "memory.cross-scope-capability";
  const category: AuditCheckCategory = "memory";
  const severity: AuditCheckSeverity = "high";

  if (!evidence) {
    return notApplicable(id, category, severity, "no run artifacts provided");
  }

  const denials = evidence.events.filter((event) => event.type === "memory.write.denied");

  if (denials.length === 0) {
    return {
      category,
      evidence: {
        deniedEventCount: 0,
        reason: "no memory.write.denied events observed; cross-scope enforcement was not exercised in this run"
      },
      id,
      severity,
      status: "not_applicable"
    };
  }

  /* v8 ignore next -- "memory.write.denied" is always in DEFAULT_PAYLOAD_MINIMUMS (conformance.ts:68); defensive fallback only */
  const requiredKeys = DENIAL_MINIMUMS_BY_TYPE.get("memory.write.denied") ?? [];
  const malformed = denials
    .map((event) => ({
      event_id: event.event_id,
      missingKeys: missingRequiredKeys(event, requiredKeys),
      requested_scope: event.payload.requested_scope,
      reason: event.payload.reason
    }))
    .filter((entry) => entry.missingKeys.length > 0);

  return {
    category,
    evidence: {
      deniedEventCount: denials.length,
      grounding: "mneme.cap.system.v1",
      malformed
    },
    id,
    severity,
    status: statusFor(malformed.length === 0)
  };
};

/**
 * Check 6 — `network.non-member-write-denied` (run). Grounded in moltnet's
 * `writeForbiddenError` (ecosystem/moltnet/internal/rooms/access_policy.go:23,71-72)
 * and the `message.denied` payload minimum (conformance.ts:67: `target`,
 * `reason`, `content_sha256`). The `writeForbiddenError` path is carried as
 * an informational `grounding` string only — this function performs no
 * static check against moltnet's source, so the status is never driven by
 * that literal.
 *
 * `not_applicable`, never `pass`, when no `message.denied` event is present:
 * non-member-write enforcement was never exercised in this run, which is not
 * evidence it works (see AGENTS.md). When one or more denial events are
 * present, every one must carry `target`, `reason`, and `content_sha256` to
 * pass.
 */
export const checkNonMemberWriteDenied = (evidence: RunLedgerEvidence | undefined): AuditCheck => {
  const id = "network.non-member-write-denied";
  const category: AuditCheckCategory = "network";
  const severity: AuditCheckSeverity = "high";

  if (!evidence) {
    return notApplicable(id, category, severity, "no run artifacts provided");
  }

  const denials = evidence.events.filter((event) => event.type === "message.denied");

  if (denials.length === 0) {
    return {
      category,
      evidence: {
        deniedEventCount: 0,
        reason: "no message.denied events observed; non-member write enforcement was not exercised in this run"
      },
      id,
      severity,
      status: "not_applicable"
    };
  }

  /* v8 ignore next -- "message.denied" is always in DEFAULT_PAYLOAD_MINIMUMS (conformance.ts:67); defensive fallback only */
  const requiredKeys = DENIAL_MINIMUMS_BY_TYPE.get("message.denied") ?? [];
  const malformed = denials
    .map((event) => ({
      event_id: event.event_id,
      missingKeys: missingRequiredKeys(event, requiredKeys),
      target: event.payload.target,
      reason: event.payload.reason
    }))
    .filter((entry) => entry.missingKeys.length > 0);

  return {
    category,
    evidence: {
      deniedEventCount: denials.length,
      grounding: "ecosystem/moltnet/internal/rooms/access_policy.go writeForbiddenError",
      malformed
    },
    id,
    severity,
    status: statusFor(malformed.length === 0)
  };
};

/**
 * Check 7 — `provenance.signed-report` — always `not_applicable`. Report
 * signing/provenance is deferred to B66; this audit generator has no
 * signing input to check and must never claim it. Takes no evidence input
 * on purpose: there is nothing yet for it to inspect.
 */
export const checkProvenanceSignedReport = (): AuditCheck =>
  notApplicable("provenance.signed-report", "provenance", "medium", "not yet enforced (see B66)");

/**
 * The seven check ids in the order `generateAudit.ts` assembles
 * `AuditReport.checks` in (each check function above takes a different
 * evidence shape, so this is a documentation/ordering list only — not a
 * uniformly-callable array).
 */
export const AUDIT_CHECK_IDS = [
  "causal.principals-authenticated",
  "causal.denied-ledger-visible",
  "control.wake-fail-closed",
  "container.no-baked-secrets",
  "memory.cross-scope-capability",
  "network.non-member-write-denied",
  "provenance.signed-report"
] as const;
