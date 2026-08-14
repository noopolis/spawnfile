#!/usr/bin/env node
// Standalone deterministic canned-reply script for a Spawnfile `engine:
// scripted` fixture agent (Slice B, Piece 5). Speaks the exact argv contract
// the pi runtime's scripted engine execs (see
// src/runtime/pi/appCliEnginesSource.ts's runScriptedEngine):
//
//   node office-engine.mjs --prompt-file <path> --cwd <workspacePath>
//
// and prints the reply text to stdout. It runs under plain `node` with no
// build step, so it cannot import src/e2e/officeSimEngines.ts (TypeScript,
// not compiled here) — the eleanor/sam screenplay strings below are a
// deliberate, intentional duplicate of that file's `OFFICE_SIM_*` constants.
// src/e2e/officeEngineScript.test.ts asserts the two stay byte-identical.
//
// Turn-taking mirrors officeSimEngines.ts's fake `grok` binary exactly:
// eleanor proposes and @mentions @sam, sam agrees and @mentions @eleanor,
// and eleanor closes with no @mention once she sees sam's agreement phrase
// echoed back into her own wake prompt — so the conversation terminates
// after exactly 3 turns instead of alternating forever.
import { readFileSync } from "node:fs";
import path from "node:path";

const ELEANOR_PROPOSE =
  "Let's pilot the downtown office and target June 1 for the file migration. @sam does that work for you?";
const SAM_ACCEPT =
  "Downtown office and June 1 works for me. @eleanor agreed, let's lock it in.";
const ELEANOR_CLOSE =
  "Great, that's settled: downtown office, go-live June 1 for the file migration. Done.";

/** Phrase that appears only in Sam's acceptance; eleanor closes (drops the
 * @mention) once the runtime feeds it back into her wake prompt. */
const AGREEMENT_MARKER = "works for me";

const args = process.argv.slice(2);
const promptIndex = args.indexOf("--prompt-file");
const prompt = promptIndex >= 0 ? readFileSync(args[promptIndex + 1], "utf8") : "";
const cwdIndex = args.indexOf("--cwd");
const cwdValue = cwdIndex >= 0 ? args[cwdIndex + 1] : "";
const agent = path.basename(cwdValue);
const agreementSeen = prompt.toLowerCase().includes(AGREEMENT_MARKER);

let reply;
if (agent === "sam") {
  reply = SAM_ACCEPT;
} else if (agent === "eleanor") {
  reply = agreementSeen ? ELEANOR_CLOSE : ELEANOR_PROPOSE;
} else {
  reply = "Nothing further to decide.";
}

process.stdout.write(reply + "\n");
