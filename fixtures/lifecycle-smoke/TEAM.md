# Lifecycle Smoke

A minimal single-agent org whose only job is to exercise `spawnfile up`,
`spawnfile artifacts export`, and `spawnfile down` end to end. It carries no
conversation script and no world/behavior instrumentation — see
`src/e2e/lifecycleSmoke.ts` for what this fixture proves and what it
deliberately does not assert.
