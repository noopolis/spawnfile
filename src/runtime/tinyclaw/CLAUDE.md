# TinyClaw Adapter Guide

This folder owns the TinyClaw runtime adapter.

## Structure

```text
src/runtime/tinyclaw/
├── adapter.ts        # TinyClaw lowering, including native team artifacts
├── runAuth.ts        # TinyClaw runtime auth coverage for spawnfile run
├── scaffold.ts       # TinyClaw-owned `spawnfile init --runtime tinyclaw` scaffold
├── scaffold-assets/  # Bundled TinyClaw starter docs copied into dist at build time
└── *.test.ts         # TinyClaw adapter/auth tests
```

TinyClaw is the current native-team adapter, so changes here should be careful about team semantics and explicit about degradation paths.

## Rules

- TinyClaw is the strongest native team model, but v0.1 should stay conservative.
- Report degradation clearly when a team cannot lower natively.
