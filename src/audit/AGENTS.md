# Audit Guide (B54)

This folder generates `spawnfile.audit.v1`: a deterministic, OFFLINE
security-audit report. It reads a compiled-output directory (and, if given,
a ledger directory) and reports what real properties it can prove — it never
runs a live Docker/Moltnet/model process, and it never enforces anything
itself.

**The one rule everything else here serves: this folder reports, it never
enforces, and it never claims a property is proven unless it actually
checked evidence for it.** A check with no run artifacts is
`not_applicable`, never `pass` — silence is not success. A property nothing
in this repo enforces yet (`provenance.signed-report`, deferred to B66) is
always `not_applicable` too, forever, until B66 actually lands and a real
check is written for it. No check here should ever be extended to claim a
property this repo does not actually enforce.

**Cardinal rule, stated precisely (post-B54-fix): absent evidence is
`not_applicable`, never `pass`.** Every run-mode check that asserts a
security *property held under enforcement* (checks 2, 5, 6 — silent-drop
detection, cross-scope capability denial, non-member-write denial) must
have at least one relevant observed event before it is allowed to `pass`.
Zero relevant events is not proof the property holds — it is proof the
property was never exercised in this run — and must report
`not_applicable` with a `reason` explaining what was never exercised. This
folder shipped a real defect against this exact rule once already: checks 5
and 6 used to compute `status: statusFor(malformed.length === 0)`, which is
trivially true when zero relevant events exist, so a ledger that never
exercised enforcement — or a broken ledger that failed to parse at all —
used to earn a green `pass` on a security property. See "The seven checks"
below for the fixed shape of checks 2, 5, and 6, and `checks.test.ts` /
`generateAudit.test.ts` for regression coverage (a zero-denial-event ledger,
and a ledger whose only line is malformed, must never see checks 2/5/6
report `pass`). Only checks 3 and 4 (static, evidence always present) and
check 1 (fails outright on any conformance issue, including zero events) are
exempt from this branch — see their descriptions below for why each is
still sound.

## Structure

```text
src/audit/
├── index.ts             # Barrel export
├── types.ts              # SPAWNFILE_AUDIT_SCHEMA + AuditCheck/AuditReport/AuditSummary types
├── checksShared.ts        # Evidence input types (RunLedgerEvidence/StaticContainerEvidence) + small pure helpers shared by every check function — split out of checks.ts solely to stay under the 400-line cap
├── checks.ts              # The seven pure per-check functions (imports evidence types + helpers from checksShared.ts, re-exports them for callers)
├── checks.test.ts
├── generateAudit.ts       # Orchestrator: the only file in this folder that does I/O
├── generateAudit.test.ts
├── readAudit.ts           # Pure reader/validator (zod) for an existing report JSON
├── readAudit.test.ts
├── auditCli.ts            # `npm run audit:generate` / `tsx src/audit/auditCli.ts` entry point
├── auditCli.test.ts
├── schema.json            # JSON Schema mirror of readAudit.ts's zod schema
└── fixtures/
    ├── good/               # Valid ledger + compiled-output fixture — every check 1-6 passes, checks 5/6 grounded in a real memory.write.denied + message.denied event each
    ├── broken-anonymous/   # Same, but one principal is system:moltnet.anonymous
    └── broken-silent-drop/ # Same, but the expected message.denied event is missing (silent drop) — check 2 fails, check 6 is not_applicable (zero message.denied events), never pass
```

Each fixture directory doubles as both a "compiled-output dir" (`Dockerfile`,
`entrypoint.sh`, `runtime/app.mjs`) and a "ledger dir" (`ledger.jsonl`,
`expected-denials.json`) — the shape `auditCli.ts --fixtures <dir>` expects.
`runtime/app.mjs` is the actual output of `renderPiControlSource()`
(src/runtime/pi/appControlSource.ts), copied verbatim; `Dockerfile` and
`entrypoint.sh` are small hand-authored fixtures that reuse the real
`require_env`/`require_file` bash function bodies from
`containerEntrypointRender.ts`, not a full `spawnfile compile` output —
running the real compiler just to produce two static text files this
generator only greps was out of scope for this offline, hermetic suite.

## The seven checks

Every check function in `checks.ts` is pure: no I/O, no imports outside
`src/ledger` (data + predicates, never re-executed logic) and `./types.ts`.
`generateAudit.ts` is the only place that reads files and calls
`runRealConformance`.

1. **`causal.principals-authenticated`** (run, critical) — reuses
   `runRealConformance` (src/ledger/conformance.ts) over the ledger jsonl:
   passes only when it reports zero issues AND `isAuthenticatedPrincipal`
   (src/ledger/principal.ts:87) accepts every event's `principal_id`. Fails
   with the offending `{event_id, principal_id}` pairs in evidence, never a
   paraphrased issue string.
2. **`causal.denied-ledger-visible`** (run, high) — every `*.denied` event
   present must carry the keys `DEFAULT_PAYLOAD_MINIMUMS`
   (conformance.ts:67-69) declares for its type. Also detects a **silent
   drop**: this fixture's own `expected-denials.json` (`{expectedDenialTypes:
   string[]}`, an audit-owned manifest — not part of the causal-event
   schema) asserts a denial type occurred; if no matching `*.denied` event
   exists in the ledger, this fails even when every event that *is* present
   is well shaped. `not_applicable`, never `pass`, when there is **no**
   `expected-denials.json` manifest in the ledger directory (tracked by
   `RunLedgerEvidence.manifestPresent`, distinct from `expectedDenialTypes`
   being empty — a present-but-empty manifest is not the same as no
   manifest at all) **and** zero `*.denied` events are present: with neither
   an assertion to check nor an event to inspect, there is nothing to
   assess. A manifest being present is enough to keep evaluating even with
   zero observed denials (silent-drop detection needs no observed event to
   fire), and any `*.denied` event that *is* present is always key-validated
   regardless of manifest presence.
3. **`control.wake-fail-closed`** (static, critical) — grounded in
   appControlSource.ts:31-47 (B62 Option B). Passes only when the compiled
   Pi app source references `SPAWNFILE_PI_CONTROL_TOKEN`, contains the
   verbatim fail-closed rejection branch text, and never bakes a literal
   default value for that env var anywhere in the compiled output.
4. **`container.no-baked-secrets`** (static, critical) — grounded in
   containerEntrypointRender.ts:232-233. Passes only when every declared
   required secret name is `require_env`-guarded in the entrypoint AND never
   appears as a literal (non-`$`-expansion) assignment in the compiled
   Dockerfile or entrypoint text.
5. **`memory.cross-scope-capability`** (run, high) — references mneme's
   `mneme.cap.system.v1` foreign-scope escalation capability
   (ecosystem/mneme/src/policy/capability.ts:28) as an **informational**
   `grounding` evidence string only — this check performs no static check
   against mneme's source, so status is never driven by that literal.
   `not_applicable`, never `pass`, with zero `memory.write.denied` events:
   enforcement was never exercised in this run, which is not evidence it
   works. Any denial event that *is* present must carry `requested_scope`
   and `reason` to pass.
6. **`network.non-member-write-denied`** (run, high) — references moltnet's
   `writeForbiddenError`
   (ecosystem/moltnet/internal/rooms/access_policy.go:23,71-72) as an
   **informational** `grounding` evidence string only — same caveat as check
   5, no static check is performed against it. `not_applicable`, never
   `pass`, with zero `message.denied` events. Any denial event that *is*
   present must carry `target`, `reason`, and `content_sha256` to pass.
7. **`provenance.signed-report`** (always `not_applicable`) — report
   signing/provenance is deferred to B66. This check takes no evidence
   input on purpose and can never be made to `pass`.

Checks 1, 2, 5, 6 take a `RunLedgerEvidence | undefined`; `undefined` (no
`*.jsonl` files found in the ledger directory) makes all four report
`not_applicable` with `{reason: "no run artifacts provided"}` — never
`pass`. Even with evidence present, checks 2, 5, and 6 have a *second*
absent-data branch (see the cardinal rule above): zero relevant `*.denied`
events (and, for check 2, no `expected-denials.json` manifest either) is
also `not_applicable`, never `pass` — evidence being present does not by
itself mean there is anything in it to assess. Checks 3 and 4 take a
`StaticContainerEvidence` that is always present (the compiled-output
directory is a required `generateAudit` input, never optional) and always
evaluate `pass`/`fail`; a missing compiled file reads as an empty string and
is itself audit-worthy, not skipped.

## How the offline ledger read works

`generateAudit.ts`'s `collectRunLedgerEvidence` reads every `*.jsonl` file in
the ledger directory, then calls `runRealConformance` (src/ledger/
conformance.ts) with an **injected `exec`** that returns each file's
pre-read text instead of spawning a real sibling emitter process
(src/ledger/emitters.ts's `Exec`/`EmitterSpec` contract). This is what keeps
the whole generator offline and hermetic while still reusing
`runRealConformance`'s real schema/seq-contiguity/payload-minimum/
principal-grammar/chain-stitch pipeline rather than reimplementing any of
it — the same technique `realConformance.test.ts` uses for its own injected-
exec unit coverage.

## Deviations from the frozen packet

- The frozen B54 packet's contract line lists `AuditCheck.category` as only
  five values (`causal|control|container|memory|network`), but every check's
  `id` prefix matches its own category exactly for checks 1-6
  (`causal.*` -> `causal`, `control.*` -> `control`, etc.). Check 7's id is
  `provenance.signed-report`, so `AuditCheckCategory` here adds a sixth
  value, `"provenance"`, to keep that same id-prefix-equals-category
  pattern rather than mis-bucketing check 7 under an unrelated category.
- `expected-denials.json` (the `{expectedDenialTypes: string[]}` manifest
  check 2's silent-drop detection reads) is an audit-owned fixture
  convention, not part of `specs/CAUSAL.md`'s wire contract — the packet
  names the silent-drop behavior but does not specify how a fixture asserts
  "a denial occurred"; this is the mechanism chosen to express that
  assertion without extending the causal-event schema itself.

## Rules

- Named exports only, no default exports (repo-wide rule).
- Keep every file under 400 lines. `checksShared.ts` exists purely to keep
  `checks.ts` under that cap as the check count/complexity grows — if you
  add an eighth check, prefer growing `checksShared.ts` or a new sibling
  module over letting `checks.ts` creep back toward 400.
- `checks.ts` and `checksShared.ts` stay pure — no `node:fs`, no
  `node:child_process`. All I/O lives in `generateAudit.ts`.
- **Absent evidence is `not_applicable`, never `pass`.** This is the
  cardinal rule stated at the top of this file. Before adding or editing any
  check: if the check's `pass` branch is reachable when the number of
  relevant observed events is zero, that is the same defect checks 5 and 6
  originally shipped with — fix it before merging, not after.
- A grounding reference to another system's source file/policy name (e.g.
  `mneme.cap.system.v1`, `writeForbiddenError`) may be carried in evidence
  as an **informational** string (see checks 5/6's `grounding` field) but
  must never be described as something this check *verified* unless a
  static check against that source actually runs (as checks 3/4 do against
  the compiled output). Never let a decorative grounding literal make a
  check's evidence read as more authoritative than what was actually
  checked.
- Do not add a check for a property this repo does not actually enforce.
  When B66 (report signing) lands, replace check 7 with a real check against
  real evidence — do not flip its status without one.
