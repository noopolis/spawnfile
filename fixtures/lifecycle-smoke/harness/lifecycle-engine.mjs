#!/usr/bin/env node
// Standalone deterministic canned-reply script for spawnfile's own
// lifecycle-smoke fixture (Slice B, Piece 5 step 5). Speaks the pi runtime's
// `scripted` engine argv contract (see
// src/runtime/pi/appCliEnginesSource.ts's runScriptedEngine):
//
//   node lifecycle-engine.mjs --prompt-file <path> --cwd <workspacePath>
//
// Always replies with the same fixed acknowledgement, regardless of prompt
// content or which agent invoked it — this fixture proves spawnfile's own
// up/artifacts-export/down lifecycle, not agent conversation behavior
// (Decision 20: transcript/turn/behavior assertions live in simfile, not
// here). One real turn is still driven so the run produces genuinely
// non-empty moltnet/mneme/daimon artifacts to export.
process.stdout.write("Lifecycle smoke acknowledged.\n");
