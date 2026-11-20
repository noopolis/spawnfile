#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { generateDaimonEngineDescriptors } from "../src/runtime/daimon/image/generateEngineDescriptors.ts";
export * from "../src/runtime/daimon/image/generateEngineDescriptors.ts";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try { generateDaimonEngineDescriptors(); } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
