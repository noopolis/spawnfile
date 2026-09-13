import * as filesystem from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { immutableWrite } from './filesystem.js';
import { appendJournal } from './journal.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
it('syncs published directory entries before returning success for artifacts and new journals', async () => {
  const root = await filesystem.mkdtemp(join(tmpdir(), 'paideia-durable-'));
  const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const syncedDirectories: string[] = [];
  vi.mocked(filesystem.open).mockImplementation(async (path, flags, mode) => {
    const file = await original.open(path, flags, mode);
    const directory = (await file.stat()).isDirectory();
    const sync = file.sync.bind(file);
    file.sync = async () => { if (directory) syncedDirectories.push(String(path)); return sync(); };
    return file;
  });
  try {
    const path = join(root, 'created', 'nested', 'artifact.json');
    await immutableWrite(path, 'published');
    expect(syncedDirectories).toContain(dirname(path));
    expect(syncedDirectories).toContain(root); // Creation of the new parent is durable too.
    syncedDirectories.length = 0;
    await appendJournal(join(root, 'events.jsonl'), { id: 'first', payload: true }, 'raw');
    expect(syncedDirectories).toContain(root);
  } finally {
    vi.mocked(filesystem.open).mockImplementation(original.open);
    await filesystem.rm(root, { recursive: true, force: true });
  }
});
