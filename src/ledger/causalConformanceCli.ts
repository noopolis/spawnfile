import { runRealConformance } from "./conformance.js";

/**
 * `npm run test:causal-conformance` entry point (B92). Runs the four real
 * sibling causal fixture emitters (simfile, mneme, daimon, moltnet — see
 * emitters.ts) by path, validates every record against the schema and
 * payload minimums, stitches them into one interaction chain, and
 * reconciles it. Prints per-source counts, any issues, and the
 * reconstructed chain edges; exits 1 when the report is not ok.
 *
 * This is a hermetic-suite exception: it spawns real processes (a `go run`
 * compile, three tsx processes), so it is its own npm script rather than a
 * vitest test — `npm test` stays fully in-process (see emitters.test.ts and
 * realConformance.test.ts for the injected-exec unit coverage of this same
 * logic).
 */
const main = async (): Promise<void> => {
  const report = await runRealConformance();

  console.log(`causal conformance: ${report.ok ? "OK" : "FAILED"} (events=${report.eventCount})`);

  console.log("per-source counts:");
  for (const { count, source } of report.sourceCounts) {
    console.log(`  - ${source}: ${count}`);
  }

  if (report.issues.length > 0) {
    console.log("issues:");
    for (const issue of report.issues) {
      const line = issue.line !== undefined ? ` (line ${issue.line})` : "";
      console.log(`  - [${issue.source}]${line} ${issue.message}`);
    }
  }

  console.log(`chain: ${report.chain.stitchedEventCount} stitched events, ${report.chain.edges.length} backward edges`);
  for (const edge of report.chain.edges) {
    console.log(`  - ${edge.from} -> ${edge.to}`);
  }

  if (!report.ok) {
    process.exitCode = 1;
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
