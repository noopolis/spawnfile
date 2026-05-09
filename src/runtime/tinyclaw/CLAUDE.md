# TinyClaw Adapter Guide

This folder owns the TinyClaw runtime adapter.

## Structure

```text
src/runtime/tinyclaw/
├── adapter.ts        # TinyClaw lowering, including native team artifacts
├── schedules.ts      # Native TinyClaw cron schedule lowering and diagnostics
├── surfaces.ts       # TinyClaw channel wiring and supported-surface restrictions
├── runAuth.ts        # TinyClaw runtime auth coverage for spawnfile run
├── scaffold.ts       # TinyClaw-owned `spawnfile init --runtime tinyclaw` scaffold
├── scaffold-assets/  # Bundled TinyClaw starter docs copied into dist at build time
└── *.test.ts         # TinyClaw adapter/auth tests
```

TinyClaw is the current native-team adapter, so changes here should be careful about team semantics and explicit about degradation paths.

## Rules

- TinyClaw is the strongest native team model, but v0.1 should stay conservative.
- Report degradation clearly when a team cannot lower natively.
- Portable HTTP is not part of the v0.1 alpha surface contract. TinyClaw's native HTTP API is runtime-specific unless a future spec reintroduces portable ingress.
- Do not add Spawnfile-owned team routing. Native team lowering must preserve representative and context semantics or report degradation.
