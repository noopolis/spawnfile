import { realpath } from 'node:fs/promises';
import path from 'node:path';

export async function canonicalProtectedPaths(paths: readonly string[] = []): Promise<string[]> {
  return Promise.all(paths.map(async (entry) => {
    if (!path.isAbsolute(entry)) throw new Error('Protected paths must be absolute existing paths');
    return realpath(entry);
  }));
}

export function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
