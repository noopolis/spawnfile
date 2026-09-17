#!/usr/bin/env node
import { runTrainingBrokerEntrypoint } from "./entrypoint.js";

/**
 * The broker-capable training image's root entrypoint process. The image ships
 * it; the host supplies only the read-only `spawnfile.training-broker.v1`
 * declaration and never a script, so no host executable enters the container.
 */
const main = async (): Promise<void> => {
  process.exitCode = await runTrainingBrokerEntrypoint({ argv: process.argv.slice(2) });
};

main().catch((error: unknown) => {
  process.stderr.write(`[training-entrypoint] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
