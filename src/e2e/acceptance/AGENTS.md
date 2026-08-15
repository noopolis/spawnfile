# Acceptance Profiles

This folder owns the acceptance profile MODEL: the predeclared "slice" and
"full" check sets, and the pure verdict logic that turns a list of reported
check results into an accept / not_accept decision.

**This folder never executes checks.** It has no IO, no process/network
access, and no imports outside `src/e2e/acceptance`. Something else (B0 for
the slice profile; B47/B55 for the full profile) runs the actual checks and
hands the resulting `AcceptanceCheckResult[]` in here for evaluation.

## Structure

```text
src/e2e/acceptance/
├── profiles.ts       # Types + SLICE_PROFILE + FULL_PROFILE + registry + getAcceptanceProfile
├── profiles.test.ts  # Contract tests: check counts, requirement mix, unique ids, refs
├── evaluate.ts        # Pure evaluateAcceptanceProfile + verdict types
├── evaluate.test.ts  # Blocking-rule and determinism tests
└── index.ts          # Barrel export
```

## Design decisions

- **D1 — an optional check that fails still blocks.** Optionality licenses
  *absence* (a skip with a stated reason), not a demonstrated *failure*. If a
  check runs and fails, that is a real, observed defect regardless of whether
  the check was declared required or optional, so R5 blocks it. The only way
  an optional check avoids blocking is by being skipped with a nonempty
  reason (A1) or by passing.
- **D2 — a missing optional check blocks, same as a missing required check.**
  A profile predeclares every check it cares about. If a check the profile
  declared never reports a result at all, that is silence, and "silence is
  not a reason" (A2): it is treated exactly like R4 (an unexplained skip) and
  blocks. Optional only means "you may skip me and tell me why," never "you
  may simply not mention me."
- **D3 — the status vocabulary is `passed | skipped | failed`, not
  preflight's `unavailable`.** `src/e2e/preflight*.ts` uses a different,
  narrower status model (`passed | skipped | unavailable`) for local
  readiness probing. This folder intentionally does not import anything from
  `preflight*` and does not reuse its status vocabulary — an acceptance
  verdict is a different concern from a local dev-machine readiness check.
  Any consumer that wants to feed a preflight-style report into
  `evaluateAcceptanceProfile` must map `unavailable -> failed` itself, at the
  call site, not inside this folder.

## Notes

- `evaluateAcceptanceProfile` is pure: given the same `AcceptanceProfile` and
  `AcceptanceCheckResult[]`, and the same injected `evaluatedAt`, it returns
  a byte-for-byte identical `AcceptanceVerdict`.
- `AcceptanceVerdict.version` is the fixed literal
  `"spawnfile.acceptance-verdict.v1"`. Bump this string (and add a new type)
  if the verdict shape ever changes incompatibly; do not mutate it in place.
- `subsystem-remote-host` is the only optional check declared in either
  profile. Every other check in both `SLICE_PROFILE` and `FULL_PROFILE` is
  required.
