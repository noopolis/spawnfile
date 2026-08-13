import type { CausalEvent } from "@noopolis/stele";
import { PRINCIPAL_GRAMMAR_SOURCE } from "@noopolis/stele";

/**
 * Principal grammar (specs/CAUSAL.md §3, `specs/causal-event.v1.schema.json`
 * `principal_id.pattern`): `agent:<agentId>` | `operator:<credentialKey|name>`
 * | `system:<system>[.<component>]`. A principal is minted only by a
 * trusted layer (root's container env, a per-agent harness config, an
 * authn claim) — never derived from `request.From`, tool arguments, or
 * model output. This module owns parsing/validating that grammar on the
 * root side, plus the per-event conformance checks conformance.ts layers
 * on top of it; it has no I/O and no knowledge of any specific authority's
 * transport.
 *
 * The grammar itself (`PRINCIPAL_GRAMMAR_SOURCE`) is defined once in
 * `envelope.ts` — the same regex `causalEventSchema` enforces on the wire —
 * and re-exported from here so existing callers of this module keep working;
 * this file never hardcodes a second copy of the pattern.
 */

export type PrincipalKind = "agent" | "operator" | "system";

export interface Principal {
  id: string;
  kind: PrincipalKind;
}

export interface PrincipalParseError {
  message: string;
}

export { PRINCIPAL_GRAMMAR_SOURCE };

/** Boolean grammar test built from the single source of truth, `PRINCIPAL_GRAMMAR_SOURCE`. */
const PRINCIPAL_PATTERN = new RegExp(PRINCIPAL_GRAMMAR_SOURCE, "u");

/**
 * `system:moltnet.anonymous` is moltnet's stamped principal for the
 * unauthenticated dev-mode case (no authn claims on the request context at
 * all) — see `ecosystem/moltnet/internal/rooms/causal.go`. It is grammar-
 * valid (a real `system:` principal) but conformance treats it as
 * unauthenticated on purpose: it is a placeholder for "no principal",
 * never a credential to attribute causal events to.
 */
export const ANONYMOUS_SYSTEM_PRINCIPAL = "system:moltnet.anonymous";

/** The literal bare string some legacy/dev paths might stamp instead of a real principal. */
const ANONYMOUS_LITERAL = "anonymous";

/**
 * Parses a `principal_id` string against the grammar. Returns a
 * `PrincipalParseError` (never throws) for anything that does not match
 * `^(agent|operator|system):.+` — a bare id with no prefix, an unknown
 * prefix, or an empty string all land here.
 */
export const parsePrincipal = (value: string): Principal | PrincipalParseError => {
  if (typeof value !== "string" || value.length === 0) {
    return { message: "principal_id must be a non-empty string" };
  }

  if (!PRINCIPAL_PATTERN.test(value)) {
    return {
      message: `principal_id "${value}" does not match the <agent|operator|system>:<id> grammar (specs/CAUSAL.md §3)`
    };
  }

  // PRINCIPAL_PATTERN already guarantees a `<kind>:<rest>` shape with a
  // known kind prefix, so a plain split on the first colon is safe and
  // avoids maintaining a second, capturing copy of the same pattern.
  const separatorIndex = value.indexOf(":");
  const kind = value.slice(0, separatorIndex) as PrincipalKind;
  const id = value.slice(separatorIndex + 1);
  return { id, kind };
};

export const isPrincipalParseError = (
  value: Principal | PrincipalParseError
): value is PrincipalParseError => "message" in value;

/**
 * True only for a principal that is both grammar-valid and represents a
 * real authenticated identity: grammar mismatches, a bare id, an empty
 * trailing id, the literal `anonymous`, and `system:moltnet.anonymous`
 * (moltnet's unauthenticated dev-mode placeholder) are all rejected.
 * Conformance (`conformance.ts`) uses this as its per-event grammar check.
 */
export const isAuthenticatedPrincipal = (value: string): boolean => {
  if (typeof value !== "string") {
    return false;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === ANONYMOUS_LITERAL || trimmed === ANONYMOUS_SYSTEM_PRINCIPAL) {
    return false;
  }

  const parsed = parsePrincipal(trimmed);
  if (isPrincipalParseError(parsed)) {
    return false;
  }

  return parsed.id.trim().length > 0;
};

/**
 * Lightweight structural sibling of `conformance.ts`'s `ConformanceIssue`
 * (message + source; no line number — these are per-event, not per-line
 * fixture checks). Kept local to this module to avoid a circular import
 * with `conformance.ts`, which imports `PRINCIPAL_DISCIPLINE_CHECKS` from
 * here; every field here is a subset of `ConformanceIssue`'s, so these
 * values are usable anywhere a `ConformanceIssue` is expected.
 */
export interface PrincipalConformanceIssue {
  message: string;
  source: string;
}

export type PrincipalEventCheck = (event: CausalEvent, sourceName: string) => PrincipalConformanceIssue[];

/** `type`s whose `principal_id` must exactly equal `emitter.stream_id` (a daimon `agent:<id>` stream). */
const AGENT_STREAM_TURN_EVENT_TYPES = new Set(["turn.input.submitted", "turn.output.completed"]);

/**
 * Principal-grammar check (specs/CAUSAL.md §3, B62 enforcement point #4a):
 * every event's `principal_id` must be an authenticated `agent:`/`operator:`/
 * `system:` principal — never a bare id, the literal `anonymous`, or
 * moltnet's `system:moltnet.anonymous` unauthenticated placeholder.
 */
export const checkPrincipalGrammar: PrincipalEventCheck = (event, sourceName) => {
  if (isAuthenticatedPrincipal(event.principal_id)) {
    return [];
  }

  return [
    {
      message:
        `event ${event.event_id} has principal_id "${event.principal_id}", which is not an authenticated ` +
        `agent:/operator:/system: principal (specs/CAUSAL.md §3)`,
      source: sourceName
    }
  ];
};

/**
 * Stream/principal consistency check (B62 enforcement point #4b): for
 * daimon's turn events, `principal_id` must exactly equal `emitter.stream_id`
 * — the agent whose stream this is must be the agent this event is
 * attributed to. This deliberately does NOT apply to daimon's control-wake
 * events (`control.wake.accepted`/`control.wake.denied`), whose stream is
 * the *target* agent being woken but whose principal is the *operator* who
 * requested the wake — an intentional mismatch, not a violation.
 */
export const checkStreamPrincipalConsistency: PrincipalEventCheck = (event, sourceName) => {
  if (event.emitter.system !== "daimon" || !AGENT_STREAM_TURN_EVENT_TYPES.has(event.type)) {
    return [];
  }
  if (!event.emitter.stream_id.startsWith("agent:") || event.principal_id === event.emitter.stream_id) {
    return [];
  }

  return [
    {
      message:
        `event ${event.event_id} is on stream ${event.emitter.stream_id} but has principal_id ` +
        `"${event.principal_id}" — daimon turn events must be attributed to the agent that owns their stream`,
      source: sourceName
    }
  ];
};

/**
 * Per-event checks `conformance.ts`'s `runSyntheticConformance` AND (as of
 * the B62 fix) `runRealConformance` both layer on top of schema parsing +
 * payload minimums, via `validateConformanceSources`'s `extraChecks`
 * parameter. Wiring this into `runRealConformance` is what gives the real
 * `npm run test:causal-conformance` path teeth: without it, a real sibling
 * emitter stamping a non-grammar `principal_id` would pass conformance
 * silently (the schema-level `PRINCIPAL_GRAMMAR_SOURCE` regex in
 * `envelope.ts` already rejects most malformed principals at parse time, but
 * `checkStreamPrincipalConsistency` in particular is conformance-only — it
 * has no envelope-schema equivalent). `realConformance.test.ts`'s hand-
 * authored fixtures are kept grammar-compliant for exactly this reason.
 */
export const PRINCIPAL_DISCIPLINE_CHECKS: PrincipalEventCheck[] = [
  checkPrincipalGrammar,
  checkStreamPrincipalConsistency
];
