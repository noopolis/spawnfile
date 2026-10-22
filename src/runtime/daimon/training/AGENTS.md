# Daimon training subjects

`legacy/` owns the public Pi facade subject; `native/` owns prepared container and child subjects. `index.ts` supplies the subject factory and optional hostInference grant authority to composition.

Container-only carve-out: dynamic package specifiers for @noopolis/daimon/pi and @noopolis/daimon/runtime live only below this folder. They load lazily inside training containers where Daimon is installed, like the generated Pi app; importing the registration on the host must never load Daimon. No host dependency on Daimon is permitted.

Real-runtime differential tests are opt-in through SPAWNFILE_DAIMON_CHECKOUT, an absolute checkout path with built dist/runtime/index.js. Static mirrors and checked-in fixtures cover ordinary installs.
