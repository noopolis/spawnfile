import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export function relativeResourcePath(value: string): string {
  if (typeof value !== 'string' || !value || isAbsolute(value) || /^[A-Za-z]:/.test(value) ||
    value.includes('\\') || value.includes('\0') || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe candidate path: ${String(value)}`);
  }
  return value;
}
export function containedPath(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}
export async function readSourceFile(root: string, path: string): Promise<{ text: string; realPath: string }> {
  const actualRoot = await realpath(root);
  const actualPath = await realpath(resolve(actualRoot, relativeResourcePath(path)));
  if (!containedPath(actualRoot, actualPath)) throw new Error('Candidate source symlink escapes its source root');
  const file = await open(actualPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1_048_576) throw new Error('Candidate source must be a regular file under 1 MiB');
    const bytes = await file.readFile();
    const text = bytes.toString('utf8');
    if (bytes.length > 1_048_576 || !Buffer.from(text).equals(bytes) || text.includes('\0')) {
      throw new Error('Candidate source must be bounded valid UTF-8 text');
    }
    return { text, realPath: actualPath };
  } finally { await file.close(); }
}
export async function assertPlainDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Candidate destination must be a plain directory');
}
