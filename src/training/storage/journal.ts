import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { open, unlink } from 'node:fs/promises';
import type { StoredEvent, Visibility } from './types.js';
import { assertIdentity, identity, jsonBytes } from './content.js';
import { readStored, syncDirectory } from './filesystem.js';
import { validateVisibility } from './permissions.js';

export interface JournalRead { events: StoredEvent[]; ignoredTailBytes: number; totalBytes: number }
export async function readJournal(path: string): Promise<JournalRead> {
  let bytes: Buffer;
  try { bytes = await readStored(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], ignoredTailBytes: 0, totalBytes: 0 };
    throw error;
  }
  const boundary = bytes.lastIndexOf(10) + 1;
  const lines = bytes.subarray(0, boundary).toString('utf8').split('\n').slice(0, -1);
  const events: StoredEvent[] = [];
  const ids = new Set<string>();
  for (const line of lines) {
    let event: StoredEvent;
    try { event = JSON.parse(line) as StoredEvent; }
    catch { throw new Error('Corrupt complete journal line'); }
    const { digest, ...body } = event;
    if (identity(body) !== digest || event.sequence !== events.length + 1) throw new Error('Journal integrity or persistence sequence mismatch');
    assertIdentity(event.id);
    validateVisibility(event.visibility);
    if (ids.has(event.id)) throw new Error('Duplicate persisted event identity');
    ids.add(event.id);
    events.push(event);
  }
  return { events, ignoredTailBytes: bytes.length - boundary, totalBytes: bytes.length };
}
export async function appendJournal(path: string, event: { id: string; payload: unknown }, visibility: Visibility): Promise<'appended' | 'duplicate'> {
  assertIdentity(event.id);
  validateVisibility(visibility);
  const lockPath = `${path}.lock`;
  const lock = await open(lockPath, 'wx', 0o600).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Journal writer is busy or requires stale-lock recovery');
    throw error;
  });
  try {
    const previous = await readJournal(path);
    if (previous.ignoredTailBytes) throw new Error('Journal has an interrupted tail; preserve evidence and recover explicitly');
    const existing = previous.events.find(item => item.id === event.id);
    if (existing) {
      if (jsonBytes(existing.payload) !== jsonBytes(event.payload) || existing.visibility !== visibility) throw new Error('Conflicting replay of an event identity');
      return 'duplicate';
    }
    const body = { id: event.id, sequence: previous.events.length + 1, visibility, payload: event.payload };
    const line = `${jsonBytes({ ...body, digest: identity(body) })}\n`;
    if (previous.totalBytes + Buffer.byteLength(line) > 67_108_864) throw new Error('Journal exceeds 64 MiB');
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(line); await file.sync(); }
    finally { await file.close(); }
    await syncDirectory(dirname(path));
    return 'appended';
  } finally { await lock.close(); await unlink(lockPath); }
}
