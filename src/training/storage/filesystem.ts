import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function plainDirectory(path: string): Promise<void> {
  const firstCreated = await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Store paths must be plain directories');
  if (firstCreated) {
    let current = resolve(path);
    while (true) {
      await syncDirectory(dirname(current));
      if (current === resolve(firstCreated)) break;
      current = dirname(current);
    }
  }
}
export async function safeStorePath(root: string, parts: string[]): Promise<string> {
  let current = root;
  for (const part of parts) {
    if (!/^[A-Za-z0-9._-]+$/.test(part) || part === '.' || part === '..') throw new Error('Unsafe store path');
    current = resolve(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Store path contains a symlink');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (!current.startsWith(`${root}${sep}`)) throw new Error('Store path escapes its root');
  return current;
}
export async function readStored(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 67_108_864) throw new Error('Stored artifact must be a bounded regular file');
    return await file.readFile();
  } finally { await file.close(); }
}
export async function immutableWrite(path: string, bytes: string | Uint8Array): Promise<void> {
  const data = Buffer.from(bytes);
  if (data.length > 67_108_864) throw new Error('Stored artifact exceeds 64 MiB');
  await plainDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(data); await file.sync(); }
  finally { await file.close(); }
  try {
    try { await link(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!(await readStored(path)).equals(data)) throw new Error('Immutable stored identity already has different bytes', { cause: error });
    }
    await syncDirectory(dirname(path));
  } finally { await unlink(temporary); }
}
export async function initializeStoreRoot(root: string): Promise<string> {
  await plainDirectory(root);
  return realpath(root);
}

export async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}
