#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { runGrokLeanWorkerLiveCheck } from "../src/runtime/daimon/image/grokLeanWorkerLiveCheck.ts";
export * from "../src/runtime/daimon/image/grokLeanWorkerLiveCheck.ts";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) runGrokLeanWorkerLiveCheck();
