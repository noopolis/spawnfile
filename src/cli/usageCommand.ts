import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";

import { listDeploymentRecords, parseExportIndex } from "../deployment/index.js";
import { resolveProjectOutputDirectory } from "../filesystem/index.js";
import { DAIMON_GROK_TURN_USAGE_LEDGER } from "../runtime/daimon/contractManifest.js";
import { readUsageLedgerViaExec, type UsageLedgerExec } from "../runtime/usageLedgerRead.js";
import { DEFAULT_OUTPUT_DIRECTORY, errorExitCode } from "../shared/index.js";
import {
  computeUsageCoverage,
  DEFAULT_USAGE_SINCE,
  filterUsageRecordsSince,
  groupUsageByAgent,
  groupUsageByEngine,
  parseUsageSinceDuration,
  type UsageAgentGroup,
  type UsageEngineGroup,
  type UsageRecord
} from "../runtime/usageLedger.js";

import type { CliStreams } from "./runCli.js";
import {
  collectOrganizationUsage,
  rosterForRecord,
  selectUsageDeployment,
  type OrganizationUsage,
  type UsageCommandLiveHandlers,
  type UsageUnitReadFailure
} from "./usageCommandLive.js";

/**
 * `spawnfile usage` — what did this organization consume.
 *
 * A separate command from `status` on purpose. `status` answers "is it
 * healthy"; usage answers "what did it consume". Different question, different
 * cadence, and `status` must not read a growing ledger on every invocation.
 *
 * Every number this command prints is a LOWER BOUND. Neither metered engine's
 * stream carries an incompleteness marker — grok's `streaming-messages-json`
 * and AGY's `stream-json` both zero-fill a bucket they cannot account for — so
 * a turn whose usage was partially zero-filled sums to a plausible total and is
 * indistinguishable from a real one. Counts are therefore reported as `>=`, and
 * coverage is always stated explicitly. AGY additionally reports no cost at
 * all, so its notional column is always `—`.
 */
export interface UsageCommandOptions {
  agent?: string;
  exported?: string;
  by?: string;
  deployment?: string;
  dockerCommand?: string;
  json?: boolean;
  out?: string;
  since?: string;
  timeout?: string;
  top?: string;
}

export interface UsageCommandResult {
  error?: string;
  /** The shared CLI convention (specs/SPEC.md §9.1, `errorExitCode`): 0 on
   * success, 2 for a usage/input error, 1 for a runtime failure that surfaced
   * after validation. */
  exitCode: 0 | 1 | 2;
  output?: string;
}

const inputFailure = (message: string): UsageCommandResult => ({ error: message, exitCode: 2 });

const formatTokens = (value: number): string => {
  if (value === 0) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
};

/**
 * `—` means unknown, never free.
 *
 * A zero notional amount is never a claim worth printing: AGY's terminal frame
 * carries no `total_cost_usd` at all, and Grok's decoder falls back to `0` for
 * a cost it could not read. Rendering either as `$0.00` would advertise a free
 * turn on a subscription that is being spent, which is precisely the silent
 * loss this command exists to prevent.
 */
const formatUsd = (value: number, turns: number): string =>
  turns === 0 || value === 0 ? "—" : `$${value.toFixed(2)}`;

const formatShare = (value: number, total: number): string =>
  total === 0 ? "—" : `${Math.round((value / total) * 100)}%`;

/** An unreadable unit is UNKNOWN usage, never zero usage, so it always gets
 * its own line and always forces the window's coverage to PARTIAL. */
const renderUnreadableUnit = (unit: UsageUnitReadFailure): string =>
  unit.reason === "ledger_read_failed"
    ? `UNREADABLE ${unit.unitId} (${unit.containerRef}): ledger read failed (${unit.detail ?? "no detail"}); its usage is unknown, not zero.`
    : `UNREADABLE ${unit.unitId} (${unit.containerRef}): container ${unit.reason}; its ledger is not included.`;

const pad = (value: string, width: number): string => value.padEnd(width);
const padStart = (value: string, width: number): string => value.padStart(width);

const renderTable = (
  usage: OrganizationUsage,
  windowed: UsageRecord[],
  options: UsageCommandOptions
): string => {
  const groupBy = options.by ?? "agent";
  const coverage = computeUsageCoverage(windowed, usage.roster.length, usage.unreadableUnits.length);
  const totalTokens = windowed.reduce((sum, record) => sum + record.total, 0);
  const lines: string[] = [];

  const coverageLabel = coverage.partial
    ? `coverage PARTIAL (${coverage.agentsReporting} of ${coverage.agentsTotal} agents)`
    : `coverage ${coverage.agentsReporting} of ${coverage.agentsTotal} agents`;
  const sourceLabel = options.exported === undefined ? "" : ` · source exported ${options.exported}`;
  lines.push(`ORG ${usage.deploymentName} · last ${options.since ?? DEFAULT_USAGE_SINCE}${sourceLabel} · ${coverageLabel}`);
  lines.push("");

  if (groupBy === "agent") {
    let rows: UsageAgentGroup[] = groupUsageByAgent(windowed, usage.roster)
      .sort((left, right) => right.tokens - left.tokens || left.agent.localeCompare(right.agent));
    if (options.agent) rows = rows.filter((row) => row.agent === options.agent);
    if (options.top) rows = rows.slice(0, Number(options.top));

    const width = Math.max(8, ...rows.map((row) => row.agent.length));
    lines.push(`${pad("agent", width)}  ${pad("engine", 8)}${padStart("turns", 7)}${padStart("tokens", 9)}${padStart("notional", 11)}${padStart("share", 7)}`);
    for (const row of rows) {
      lines.push(`${pad(row.agent, width)}  ${pad(row.engine ?? "—", 8)}${padStart(row.turns === 0 ? "—" : String(row.turns), 7)}${padStart(formatTokens(row.tokens), 9)}${padStart(formatUsd(row.notionalUsd, row.turns), 11)}${padStart(formatShare(row.tokens, totalTokens), 7)}`);
    }
    lines.push("─".repeat(width + 44));
  }

  const engineRows: UsageEngineGroup[] = groupUsageByEngine(windowed)
    .sort((left, right) => right.tokens - left.tokens || left.engine.localeCompare(right.engine));
  const engineWidth = Math.max(8, ...engineRows.map((row) => row.engine.length));
  for (const row of engineRows) {
    lines.push(`${pad(row.engine, engineWidth)}  ${pad("", 8)}${padStart(String(row.turns), 7)}${padStart(formatTokens(row.tokens), 9)}${padStart(formatUsd(row.notionalUsd, row.turns), 11)}`);
  }
  if (engineRows.length === 0) lines.push("no metered turns in this window");

  lines.push("");
  lines.push("Counts are a lower bound: the engine stream carries no completeness marker.");
  if (coverage.incompleteRecordCount > 0) {
    lines.push(`${coverage.incompleteRecordCount} turn(s) reported all-zero usage and are counted as unknown, not free.`);
  }
  for (const unit of usage.unreadableUnits) {
    lines.push(renderUnreadableUnit(unit));
  }
  return lines.join("\n");
};

/** Where `artifactsExportPlan.ts` lands the ledger inside an exported run
 * directory. Both halves are derived from the same pinned contract constant the
 * export plan derives them from, so the two cannot drift apart. */
const EXPORTED_USAGE_DIRECTORY = "raw/daimon";
const exportedLedgerPaths = (exportedDirectory: string) => {
  const resolve = (absoluteContainerPath: string): string => path.join(
    exportedDirectory,
    EXPORTED_USAGE_DIRECTORY,
    path.posix.basename(absoluteContainerPath)
  );
  return {
    filePath: resolve(DAIMON_GROK_TURN_USAGE_LEDGER.filePath),
    rotatedFilePath: resolve(DAIMON_GROK_TURN_USAGE_LEDGER.rotatedFilePath)
  };
};

/**
 * Reads exported ledger bytes through the SAME reader the live path uses.
 *
 * `readUsageLedgerViaExec` is duck-typed on `exec(["cat", file])`, so feeding it
 * a file-backed exec reuses the rotation ordering, the parse, and the
 * absent-vs-unreadable classification verbatim rather than growing a second
 * copy that could drift. A missing file is re-shaped into the failure a real
 * `cat` produces — numeric exit code plus "No such file or directory" — because
 * that is the exact shape the shared reader recognises as a legitimately absent
 * generation. Every other filesystem error keeps its own `code`, which that
 * reader treats as UNKNOWN rather than empty.
 */
const exportedLedgerExec: UsageLedgerExec = async (command) => {
  const filePath = command[command.length - 1]!;
  try {
    return { stderr: "", stdout: await readFile(filePath, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const message = `cat: ${filePath}: No such file or directory`;
      throw Object.assign(new Error(message), { code: 1, stderr: message });
    }
    throw error;
  }
};

/** `stat`, not a read: a rotated generation is at least 64 MiB, so probing for
 * presence must not pull the bytes in only to throw them away. */
const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
};

/**
 * Reads one sealed, exported run instead of a live container.
 *
 * The roster still comes from the deployment record, exactly as the live path
 * resolves it, so the coverage denominator means the same thing in both modes —
 * that equivalence is the point, and it is what lets a single aggregation layer
 * serve both.
 *
 * The one semantic that CANNOT be shared is what an absent ledger means. On a
 * running container an absent file is genuinely "no turns yet", so the shared
 * reader stays silent about it. In an export it means the bytes were never
 * captured — a codex-only organization is never provisioned the volume, and an
 * export taken before the first metered turn carries nothing — and neither of
 * those is evidence that the organization cost nothing. So when the export
 * carries no generation at all this reports an explicit unreadable unit, which
 * forces coverage PARTIAL and keeps every notional column at `—`, rather than
 * rendering a confident `$0.00` over a ledger nobody ever read.
 */
const collectExportedUsage = async (
  exportedDirectory: string,
  options: UsageCommandOptions,
  outputDirectory: string,
  handlers: UsageCommandLiveHandlers
): Promise<(OrganizationUsage & { runId: string }) | { error: string }> => {
  const indexPath = path.join(exportedDirectory, "spawnfile", "export-index.json");
  let index;
  try {
    index = parseExportIndex(JSON.parse(await readFile(indexPath, "utf8")));
  } catch (error) {
    return {
      error: `Not a Spawnfile export directory: ${exportedDirectory} (${indexPath}: ${
        error instanceof Error ? error.message : String(error)
      }). Produce one with \`spawnfile artifacts export --out <dir>\`.`
    };
  }

  const list = handlers.listDeploymentRecords ?? listDeploymentRecords;
  const selected = selectUsageDeployment(
    await list(outputDirectory),
    options.deployment ?? index.deployment
  );
  if ("error" in selected) return selected;

  const paths = exportedLedgerPaths(exportedDirectory);
  const present = await Promise.all([fileExists(paths.filePath), fileExists(paths.rotatedFilePath)]);
  if (!present.some(Boolean)) {
    return {
      deploymentName: selected.name,
      records: [],
      roster: rosterForRecord(selected),
      runId: index.run_id,
      unreadableUnits: [{
        containerRef: exportedDirectory,
        detail: `${EXPORTED_USAGE_DIRECTORY}/${path.posix.basename(DAIMON_GROK_TURN_USAGE_LEDGER.filePath)} is not in this export`,
        reason: "ledger_read_failed",
        unitId: `export:${index.run_id}`
      }]
    };
  }

  const read = await readUsageLedgerViaExec(exportedLedgerExec, paths);
  return {
    deploymentName: selected.name,
    records: read.records,
    roster: rosterForRecord(selected),
    runId: index.run_id,
    unreadableUnits: read.unreadable.map((failure) => ({
      containerRef: exportedDirectory,
      detail: `${failure.filePath}: ${failure.reason}`,
      reason: "ledger_read_failed" as const,
      unitId: `export:${index.run_id}`
    }))
  };
};

export const executeUsageCommand = async (
  inputPath: string,
  options: UsageCommandOptions,
  handlers: UsageCommandLiveHandlers = {}
): Promise<UsageCommandResult> => {
  const since = options.since ?? DEFAULT_USAGE_SINCE;
  const sinceMs = parseUsageSinceDuration(since);
  if (sinceMs === null) {
    return inputFailure(`Invalid --since "${since}". Use a duration like 30m, 24h, or 7d.`);
  }
  if (options.by !== undefined && options.by !== "agent" && options.by !== "engine") {
    return inputFailure(`Invalid --by "${options.by}". Use "agent" or "engine".`);
  }
  if (options.top !== undefined && !/^[1-9]\d*$/u.test(options.top)) {
    return inputFailure(`Invalid --top "${options.top}". Use a positive integer.`);
  }
  const timeoutMs = options.timeout === undefined ? undefined : Number(options.timeout);
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    return inputFailure(`Invalid --timeout "${options.timeout}". Use a positive number of milliseconds.`);
  }

  const outputDirectory = resolveProjectOutputDirectory(inputPath, options.out, DEFAULT_OUTPUT_DIRECTORY);
  let usage: OrganizationUsage | { error: string };
  try {
    // Source selection is explicit, never inferred from what happens to be
    // reachable: --exported reads that sealed run and never contacts Docker,
    // and without it the live container is read exactly as before. Passing
    // --exported alongside a running organization still reads the export --
    // that is the point of naming it -- and the rendered header says which
    // source produced the numbers so a reader is never left guessing.
    usage = options.exported === undefined
      ? await collectOrganizationUsage({
        deployment: options.deployment,
        dockerCommand: options.dockerCommand,
        outputDirectory,
        timeoutMs
      }, handlers)
      : await collectExportedUsage(options.exported, options, outputDirectory, handlers);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), exitCode: errorExitCode(error) };
  }
  if ("error" in usage) return inputFailure(usage.error);

  const windowed = filterUsageRecordsSince(usage.records, sinceMs)
    .filter((record) => options.agent === undefined || record.agent === options.agent);

  if (options.json) {
    const coverage = computeUsageCoverage(windowed, usage.roster.length, usage.unreadableUnits.length);
    return {
      exitCode: 0,
      output: `${JSON.stringify({
        version: "spawnfile.usage.v1",
        deployment: usage.deploymentName,
        source: options.exported === undefined ? "live" : "exported",
        since,
        lowerBound: true,
        coverage,
        byAgent: groupUsageByAgent(windowed, usage.roster),
        byEngine: groupUsageByEngine(windowed),
        unreadableUnits: usage.unreadableUnits
      }, null, 2)}`
    };
  }

  return { exitCode: 0, output: renderTable(usage, windowed, { ...options, since }) };
};

export const registerUsageCommand = (
  program: Command,
  streams: CliStreams,
  setExitCode: (exitCode: 0 | 1 | 2) => void,
  handlers: UsageCommandLiveHandlers = {}
): void => {
  program
    .command("usage")
    .description("Show what a deployed Spawnfile organization consumed, by agent and by engine")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("--out <dir>", "Compile output directory")
    .option("--exported <directory>", "Read a sealed run exported by `spawnfile artifacts export --out <dir>` instead of a live container")
    .option("--deployment <name>", "Deployment record name")
    .option("--since <duration>", `Window to report, e.g. 30m, 24h, 7d (default ${DEFAULT_USAGE_SINCE})`)
    .option("--by <dimension>", "Group by \"agent\" (default) or \"engine\"")
    .option("--agent <id>", "Report one agent")
    .option("--top <n>", "Show only the n heaviest agents")
    .option("--json", "Render machine-readable JSON")
    .option("--docker-command <command>", "Docker command")
    .option("--timeout <ms>", "Bound Docker reads in milliseconds")
    .action(async (inputPath: string, options: UsageCommandOptions) => {
      const result = await executeUsageCommand(inputPath, options, handlers);
      setExitCode(result.exitCode);
      if (result.error) streams.stderr(`error: ${result.error}`);
      if (result.output) streams.stdout(result.output);
    });
};
