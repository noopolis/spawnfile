import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

export function within(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === '' || value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

export async function readPrivateFile(file: string, maximum = 1_048_576): Promise<string> {
  const entry = await lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > maximum || entry.nlink !== 1) throw new Error('Unsafe or oversized native input');
  const text = await readFile(file, 'utf8');
  if (Buffer.byteLength(text) > maximum) throw new Error('Native input exceeded its size bound');
  return text;
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
