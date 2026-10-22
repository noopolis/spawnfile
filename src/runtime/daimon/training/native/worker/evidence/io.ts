import { lstat, readdir, readFile, rename, open } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readPrivateFile } from '../../receipt/index.js';

const MAX_STREAM = 64 * 1024 * 1024;
class IncompleteNativeStreamError extends Error {}
/** Retry observations only: never replay a native acceptance or other mutation. */
export async function settleNativeRead<T>(kind: string, read: () => Promise<T>, timeoutMs = 1000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try { return await read(); }
    catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof IncompleteNativeStreamError)) throw error;
      const remaining = deadline - performance.now();
      // SyntaxError messages may contain evidence bytes. Publish only our label.
      if (remaining <= 0) {
        const Failure = error instanceof SyntaxError ? SyntaxError : Error;
        throw new Failure(`Native ${kind} JSON did not settle before deadline (empty, torn, truncated or corrupt)`,
          { cause: new Error('Native JSON decoding failed') });
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining)));
    }
  }
}

export async function readJson(file: string, kind: string, maximum: number): Promise<unknown> {
  return settleNativeRead(kind, async () => JSON.parse(await readPrivateFile(file, maximum)) as unknown);
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed native evidence record');
  return value as Record<string, unknown>;
}
export function timestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}
export async function jsonLines(file: string, kind: string, maximum = MAX_STREAM, maximumLine = maximum, settleEmpty = false): Promise<unknown[]> {
  let incomplete = false;
  return settleNativeRead(kind, async () => {
    let source: string;
    try { source = await readPrivateFile(file, maximum); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!incomplete) return [];
      throw new IncompleteNativeStreamError('incomplete stream disappeared', { cause: new Error('Native stream unavailable') });
    }
    // An empty append-only ledger is valid before its first row. After observing
    // a torn row it cannot erase that row by temporarily becoming empty.
    if ((incomplete || settleEmpty) && !source || source && !source.endsWith('\n')) {
      incomplete = true;
      throw new IncompleteNativeStreamError('torn final record');
    }
    try {
      return source.split('\n').filter(Boolean).map(line => {
        if (Buffer.byteLength(line, 'utf8') + 1 > maximumLine) throw new Error(`Native ${kind} record exceeds its byte bound`);
        return JSON.parse(line) as unknown;
      });
    } catch (error) { incomplete = true; throw error; }
  });
}

export async function files(directory: string): Promise<string[]> {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Native evidence directory must be real');
    return await readdir(directory);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

/**
 * Where a single wake's terminal frame is filed, beside the trial's latest one.
 *
 * `evidence.json` is renamed over on every delivery, so a trial that ran several
 * wakes kept only its last frame and the account of every earlier wake — the
 * assignment that really bound, over a closed trace — was gone by the time
 * anything read it. Each delivery now also files its own frame under its
 * delivery ordinal, which is never reused within a trial, so the frames
 * accumulate instead of replacing one another. Nothing is merged: each file
 * holds exactly one wake's frame and that frame names its own wake.
 */
export function wakeEvidenceFile(file: string, ordinal: number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new Error('Invalid native evidence delivery ordinal');
  const extension = extname(file);
  return `${file.slice(0, file.length - extension.length)}.${ordinal}${extension}`;
}

export async function writeEvidence(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, file);
  const directory = await open(dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  let written: unknown;
  try { written = JSON.parse(await readFile(file, 'utf8')) as unknown; }
  catch { throw new Error('Native terminal evidence JSON readback failed'); }
  if (JSON.stringify(written) !== JSON.stringify(value)) throw new Error('Native evidence readback differs');
}
