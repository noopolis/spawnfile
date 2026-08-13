import { writeFile } from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";

import { generateAudit } from "./generateAudit.js";

export interface AuditCliOptions {
  compiledOutput?: string;
  fixtures?: string;
  ledger?: string;
  out?: string;
  requiredSecret?: string[];
}

const collectRepeatable = (value: string, previous: string[]): string[] => [...previous, value];

/**
 * `npm run audit:generate` entry point / `tsx src/audit/auditCli.ts`. Two
 * input modes: `--fixtures <dir>` treats one directory as BOTH the
 * compiled-output root (`Dockerfile`/`entrypoint.sh`/`runtime/app.mjs`) and
 * the ledger root (`*.jsonl` + `expected-denials.json`) — the shape every
 * `src/audit/fixtures/<name>/` directory uses. `--compiled-output <dir>` /
 * `--ledger <dir>` set them independently, for a real `spawnfile compile`
 * output paired with a separately-located ledger capture. Prints the report
 * JSON to stdout (or writes it to `--out <path>`), a one-line summary to
 * stderr, and exits 1 if any check failed.
 */
export const runAuditCli = async (argv: string[]): Promise<void> => {
  const command = new Command();
  command
    .name("spawnfile audit:generate")
    .description("Generate a deterministic offline spawnfile.audit.v1 security-audit report")
    .option("--fixtures <dir>", "Directory used as both the compiled-output and ledger root")
    .option("--compiled-output <dir>", "Compiled-output directory (Dockerfile/entrypoint.sh/runtime/app.mjs)")
    .option("--ledger <dir>", "Ledger directory (*.jsonl + expected-denials.json)")
    .option("--required-secret <name>", "Required secret env var name (repeatable)", collectRepeatable, [])
    .option("--out <path>", "Write the report JSON to this path instead of stdout");

  await command.parseAsync(argv, { from: "user" });
  const options = command.opts<AuditCliOptions>();

  const compiledOutputDirPath = options.compiledOutput ?? options.fixtures;
  const ledgerDirPath = options.ledger ?? options.fixtures;

  if (!compiledOutputDirPath) {
    throw new Error("audit:generate requires --fixtures <dir> or --compiled-output <dir>");
  }

  const report = await generateAudit({
    compiledOutputDirPath,
    ledgerDirPath,
    requiredSecrets: options.requiredSecret
  });

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) {
    await writeFile(path.resolve(options.out), json, "utf8");
  } else {
    process.stdout.write(json);
  }

  process.stderr.write(
    `spawnfile audit: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.na} n/a\n`
  );

  if (report.summary.failed > 0) {
    process.exitCode = 1;
  }
};

// Only run when invoked directly (`tsx src/audit/auditCli.ts ...`), never on
// import — this keeps `runAuditCli` safely testable in isolation. Not
// unit-testable itself (import.meta.url never equals process.argv[1] under
// vitest), mirroring how src/ledger/causalConformanceCli.ts's own bottom
// bootstrap is excluded from coverage.
/* v8 ignore start -- process entrypoint bootstrap, exercised by `npm run audit:generate` / the CLI-run validate step, not by unit tests */
if (import.meta.url === `file://${process.argv[1]}`) {
  runAuditCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
}
/* v8 ignore stop */
