import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { syncDirectorySync } from "./durableWrite.js";

export interface JsonlReadResult<T> { entries: T[]; errors: string[] }

interface ParsedLine<T> { line: string; entry?: T }

const parseLines = <T>(text: string, isEntry: (value: unknown) => value is T): { lines: ParsedLine<T>[]; errors: string[] } => {
  const raw = text.split("\n"), errors: string[] = [];
  if (raw.at(-1) === "") raw.pop();
  const lines = raw.map((line, index): ParsedLine<T> => {
    try {
      const value: unknown = JSON.parse(line);
      if (!isEntry(value)) throw new Error("invalid entry");
      return { line, entry: value };
    } catch {
      errors.push(`line ${index + 1}: invalid JSON or entry`);
      return { line };
    }
  });
  return { lines, errors };
};

/** Missing history is empty; unreadable or corrupt history is reported, never hidden. */
export const readRetainedJsonl = <T>(file: string, isEntry: (value: unknown) => value is T): JsonlReadResult<T> => {
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch (error) {
    return { entries: [], errors: (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : [`${file}: ${String(error)}`] };
  }
  const parsed = parseLines(text, isEntry);
  return { entries: parsed.lines.flatMap(({ entry }) => entry === undefined ? [] : [entry]), errors: parsed.errors };
};

/** Ties use the last appended entry. No chronological ordering of the input is assumed. */
export const entryAt = <T>(entries: readonly T[], instant: string | Date, timeOf: (entry: T) => string): T | null => {
  const at = instant instanceof Date ? instant.getTime() : Date.parse(instant);
  if (!Number.isFinite(at)) throw new Error("History lookup requires a valid instant");
  let found: T | null = null, latest = -Infinity;
  for (const entry of entries) {
    const time = Date.parse(timeOf(entry));
    if (time <= at && time >= latest) { latest = time; found = entry; }
  }
  return found;
};

/** The last state at the cutoff is needed even if it is arbitrarily old. */
export const retainEntries = <T>(entries: readonly T[], cutoff: number, timeOf: (entry: T) => string): T[] => {
  let boundary = -1, latest = -Infinity;
  entries.forEach((entry, index) => {
    const time = Date.parse(timeOf(entry));
    if (time <= cutoff && time >= latest) { latest = time; boundary = index; }
  });
  return entries.filter((entry, index) => index === boundary || Date.parse(timeOf(entry)) > cutoff);
};

const writeAndSync = (fd: number, text: string): void => {
  const bytes = Buffer.from(text, "utf8");
  if (writeSync(fd, bytes) !== bytes.length) throw new Error("Short recording log write");
  fsyncSync(fd);
};

/**
 * Caller MUST hold its domain's writer lock across append + prune. One append write,
 * then fsync; retention uses an exclusive 0600 temporary file and atomic rename.
 * Invalid complete lines survive pruning so readers can continue reporting them.
 * A torn tail refuses append: never join a new entry onto a partial JSON record.
 */
export const appendRetainedJsonl = <T>(file: string, entry: T, options: {
  keepMs: number; now: Date; timeOf: (entry: T) => string; isEntry: (value: unknown) => value is T;
  retain?: (entries: readonly T[], cutoff: number) => T[];
}): void => {
  if (!Number.isSafeInteger(options.keepMs) || options.keepMs <= 0 || !Number.isFinite(options.now.getTime())) {
    throw new Error("Recording retention requires a positive safe duration and valid clock");
  }
  if (!options.isEntry(entry)) throw new Error("Refusing to append an invalid recording entry");
  let previous = "";
  try { previous = readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (previous && !previous.endsWith("\n")) throw new Error(`Recording log ${file} has an incomplete final line`);
  const line = `${JSON.stringify(entry)}\n`;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try { fchmodSync(fd, 0o600); writeAndSync(fd, line); } finally { closeSync(fd); }
  syncDirectorySync(path.dirname(file));

  const parsed = parseLines(previous + line, options.isEntry);
  const entries = parsed.lines.flatMap(({ entry: value }) => value === undefined ? [] : [value]);
  const cutoff = options.now.getTime() - options.keepMs;
  const retained = new Set(options.retain ? options.retain(entries, cutoff) : retainEntries(entries, cutoff, options.timeOf));
  const kept = parsed.lines.filter(({ entry: value }) => value === undefined || retained.has(value));
  if (kept.length === parsed.lines.length) return;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const scratch = openSync(temporary, "wx", 0o600);
    try { writeAndSync(scratch, `${kept.map(({ line: raw }) => raw).join("\n")}\n`); } finally { closeSync(scratch); }
    renameSync(temporary, file);
    syncDirectorySync(path.dirname(file));
  } finally { rmSync(temporary, { force: true }); }
};
