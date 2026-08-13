import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";

const ERROR = "Target journal filesystem failed";
const MAX_PATH_BYTES = 4_096;

const fail = (): never => { throw new TypeError(ERROR); };
const owner = (): number | undefined => process.getuid?.();
const pathInput = (raw: unknown): string => {
  if (typeof raw !== "string" || raw.length === 0
    || Buffer.byteLength(raw, "utf8") > MAX_PATH_BYTES) return fail();
  return path.resolve(raw);
};
const ownedDirectory = (stats: Awaited<ReturnType<typeof lstat>>): boolean =>
  stats.isDirectory()
  && !stats.isSymbolicLink()
  && (owner() === undefined || stats.uid === owner());

export const prepareTargetJournalRoot = async (raw: unknown): Promise<string> => {
  const root = pathInput(raw); const parsed = path.parse(root); let current = parsed.root;
  for (const part of root.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stats;
    try { stats = await lstat(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail();
      await mkdir(current, { mode: 0o700 }).catch(fail);
      stats = await lstat(current).catch(fail);
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) return fail();
  }
  await chmod(root, 0o700).catch(fail);
  const final = await lstat(root).catch(fail);
  if (!ownedDirectory(final) || (final.mode & 0o777) !== 0o700) return fail();
  return root;
};

export const findExistingTargetJournalRoot = async (
  raw: unknown
): Promise<string | null> => {
  const root = pathInput(raw); const parsed = path.parse(root); let current = parsed.root;
  for (const part of root.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stats;
    try { stats = await lstat(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return fail();
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) return fail();
  }
  const final = await lstat(root).catch(fail);
  if (!ownedDirectory(final) || (final.mode & 0o777) !== 0o700) return fail();
  return root;
};

const validFile = (
  stats: Stats,
  maxBytes: number
): boolean =>
  stats.isFile()
  && stats.size <= maxBytes
  && stats.nlink === 1
  && (stats.mode & 0o777) === 0o600
  && (owner() === undefined || stats.uid === owner());

export const readTargetJournalFile = async (
  filePath: string,
  maxBytes: number
): Promise<string | null> => {
  let pathStats;
  try { pathStats = await lstat(filePath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return fail();
  }
  if (pathStats.isSymbolicLink() || !validFile(pathStats, maxBytes)) return fail();
  let handle;
  try { handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { return fail(); }
  try {
    const before = await handle.stat();
    if (!validFile(before, maxBytes)
      || before.dev !== pathStats.dev || before.ino !== pathStats.ino
      || before.size !== pathStats.size) return fail();
    const text = await handle.readFile({ encoding: "utf8" });
    const after = await handle.stat();
    if (!validFile(after, maxBytes)
      || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
      || Buffer.byteLength(text, "utf8") !== after.size) return fail();
    return text;
  } catch { return fail(); }
  finally { await handle.close().catch(() => undefined); }
};
