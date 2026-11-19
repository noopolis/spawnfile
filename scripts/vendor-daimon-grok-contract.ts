#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { vendorDaimonGrokContract } from "../src/runtime/daimon/image/vendorGrokContract.ts";
export * from "../src/runtime/daimon/image/vendorGrokContract.ts";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  vendorDaimonGrokContract().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
