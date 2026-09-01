/**
 * Transport half of Daimon's per-turn usage ledger reader
 * (`noopolis.daimon.turn-usage.v1`, see `specs/USAGE_ACCOUNTING_DESIGN.md`). Split
 * out of `usageLedger.ts` so that file stays a pure parser/aggregator and this
 * one owns the single I/O-shaped concern: `cat` two ledger generations through
 * a caller-supplied `exec` and decide, per generation, whether a failed read
 * means "empty" or "unknown".
 *
 * `exec` is duck-typed (structurally the same shape as
 * `RuntimeProbeGateway.exec` in `./types.ts`) rather than a concrete gateway,
 * so this module never depends on `src/deployment` — which already imports
 * real exports from this folder, and so must not be imported back.
 */

import { parseUsageLedger, type UsageRecord } from "./usageLedger.js";

/** The exec shape this module needs to read a ledger — structurally the same
 * as `RuntimeProbeGateway.exec` (`./types.ts`), duck-typed here rather than
 * imported so this module never depends on a concrete gateway construction
 * path. */
export type UsageLedgerExec = (
  command: string[]
) => Promise<{ stderr: string; stdout: string }>;

export interface UsageLedgerPaths {
  filePath: string;
  rotatedFilePath: string;
}

/** One ledger generation that exists but could not be read. Never merged into
 * the record stream and never rendered as zero usage: the caller must surface
 * it so an unknown window is not mistaken for a cheap one. */
export interface UsageLedgerReadFailure {
  filePath: string;
  reason: string;
}

export interface UsageLedgerRead {
  records: UsageRecord[];
  unreadable: UsageLedgerReadFailure[];
}

/** Same redaction discipline as the docker probe gateway's own failure
 * summaries — written here rather than imported because this module must not
 * depend on `src/deployment` (see the module doc). */
const boundedReadFailure = (error: unknown): string => {
  const text = ((): string => {
    if (error && typeof error === "object") {
      const candidate = error as { message?: unknown; stderr?: unknown };
      if (typeof candidate.stderr === "string" && candidate.stderr.trim().length > 0) {
        return candidate.stderr;
      }
      if (typeof candidate.message === "string") return candidate.message;
    }
    return String(error);
  })();
  return text
    .replace(/\s+/gu, " ")
    .replace(/(bearer|token|password|passwd|secret|authorization)[=: ]+(?:bearer[ ]+)?[^ ]+/giu, "$1=[redacted]")
    .replace(/https?:\/\/[^ ]+/giu, "[url redacted]")
    .trim()
    .slice(0, 240) || "ledger read failed";
};

/**
 * True only for the one failure that legitimately means "there is nothing
 * here": the file does not exist. That is the normal state of
 * `usage.jsonl.1` before the first rotation, and of `usage.jsonl` before the
 * first turn ever completes, so it must stay silent.
 *
 * Everything else — a `maxBuffer` overrun on a rotated generation, the read
 * timing out, the daemon being unreachable, the container having gone away —
 * is an UNKNOWN number of turns, and reporting it as zero is exactly the
 * silent data loss `spawnfile usage` exists to prevent. A killed or
 * string-coded failure is never read as absence no matter what text it
 * carries, because a truncated or aborted read can still have emitted
 * unrelated stderr.
 */
const isAbsentLedgerFile = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    killed?: unknown;
    message?: unknown;
    signal?: unknown;
    stderr?: unknown;
  };
  if (candidate.killed === true || (candidate.signal !== undefined && candidate.signal !== null)) {
    return false;
  }
  // Node reports spawn/stream failures with a string `code`
  // (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, or `ENOENT` for a missing docker
  // binary); a plain non-zero `cat` exit carries a numeric one.
  if (typeof candidate.code === "string") return false;
  const stderr = typeof candidate.stderr === "string" ? candidate.stderr : "";
  const message = typeof candidate.message === "string" ? candidate.message : "";
  return /no such file or directory/iu.test(`${stderr}\n${message}`);
};

/** `cat`s one generation through `exec`. A genuinely absent file reads as
 * empty; every other failure is reported, never swallowed. */
const readLedgerGeneration = async (
  exec: UsageLedgerExec,
  filePath: string
): Promise<{ failure?: UsageLedgerReadFailure; text: string }> => {
  try {
    const result = await exec(["cat", filePath]);
    return { text: result.stdout };
  } catch (error) {
    if (isAbsentLedgerFile(error)) return { text: "" };
    return { failure: { filePath, reason: boundedReadFailure(error) }, text: "" };
  }
};

/**
 * Reads both ledger generations (`usage.jsonl` and `usage.jsonl.1`) through
 * `exec` and parses them. Rotated (older) records are returned before
 * current ones so a `--since` window spanning a rotation reads in
 * chronological order.
 *
 * Generations that could not be read come back in `unreadable` rather than as
 * missing records, so the caller can render an UNREADABLE row and mark the
 * window partial instead of reporting an unknown amount of usage as zero.
 */
export const readUsageLedgerViaExec = async (
  exec: UsageLedgerExec,
  paths: UsageLedgerPaths
): Promise<UsageLedgerRead> => {
  const [rotated, primary] = await Promise.all([
    readLedgerGeneration(exec, paths.rotatedFilePath),
    readLedgerGeneration(exec, paths.filePath)
  ]);
  return {
    records: [...parseUsageLedger(rotated.text), ...parseUsageLedger(primary.text)],
    unreadable: [rotated.failure, primary.failure].filter(
      (failure): failure is UsageLedgerReadFailure => failure !== undefined
    )
  };
};
