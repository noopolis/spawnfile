import { lstat, readdir, readFile, rename, open } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readPrivateFile } from '../../receipt/index.js';

const MAX_STREAM = 64 * 1024 * 1024;
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed native evidence record');
  return value as Record<string, unknown>;
}
export function timestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}
export async function jsonLines(file: string, maximum = MAX_STREAM, maximumLine = maximum): Promise<unknown[]> {
  let source: string;
  try { source = await readPrivateFile(file, maximum); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  if (source && !source.endsWith('\n')) throw new Error('Native evidence stream has a torn final record');
  return source.split('\n').filter(Boolean).map(line => {
    if (Buffer.byteLength(line, 'utf8') + 1 > maximumLine) throw new Error('Native evidence record exceeds its byte bound');
    return JSON.parse(line) as unknown;
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
  const written = JSON.parse(await readFile(file, 'utf8')) as unknown;
  if (JSON.stringify(written) !== JSON.stringify(value)) throw new Error('Native evidence readback differs');
}
