# Daimon training subjects

`legacy/` owns the public Pi facade subject; `native/` owns prepared container and child subjects. `index.ts` supplies the subject factory and optional hostInference grant authority to composition.

Container-only carve-out: dynamic package specifiers for @noopolis/daimon/pi and @noopolis/daimon/runtime live only below this folder. They load lazily inside training containers where Daimon is installed, like the generated Pi app; importing the registration on the host must never load Daimon. No host dependency on Daimon is permitted.

Real-runtime differential tests use SPAWNFILE_DAIMON_CHECKOUT, an absolute checkout path with built dist/runtime/index.js: required in CI, opt-in locally. CI builds the runtimes.yaml pin; DAIMON_SOURCE_ROOT separately selects Git source for compiler recovery tests. Static mirrors and checked-in fixtures cover ordinary installs.

`providers/grok-subscription/` owns saved-login inference and the shared CLI protocol; `providers/grok-broker/` owns broker grants and its bounded pool. `services/` owns durable subject slot freshness. These belong here because this runtime owns the engine broker and subject preparation.
