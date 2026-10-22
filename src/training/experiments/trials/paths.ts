import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, opendir, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { TrialPaths } from './types.js';

const contains = (parent: string, child: string): boolean => {
  const name = relative(parent, child);
  return name === '' || name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name);
};

/**
 * Requires confirmed native closure: no subject process remains alive. Handle-bound
 * chmod protects the checked inode; ancestor swaps still require a concurrent
 * writer, which the closure gate must exclude. This is not general race freedom.
 */
async function makeScratchRemovable(allocated: string): Promise<void> {
  const uid = process.getuid?.();
  let entries = 0;
  async function visit(path: string, depth: number): Promise<void> {
    if (++entries > 100_000 || depth > 256) {
      throw new Error('Subject scratch permission walk exceeded its entry/depth limit');
    }
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) return;
    if (!contains(allocated, path) || await realpath(path) !== path) {
      throw new Error('Refusing permission changes outside allocated subject scratch');
    }
    if (uid === undefined || info.uid !== uid) {
      throw new Error(`Refusing permission changes to subject scratch owned by another uid: ${path}`);
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isDirectory() || opened.uid !== uid || opened.dev !== info.dev || opened.ino !== info.ino) {
        throw new Error(`Refusing permission changes to replaced subject scratch: ${path}`);
      }
      // Unlinking needs write/search on the parent; read-only files need no changes.
      if ((opened.mode & 0o300) !== 0o300) await handle.chmod(opened.mode | 0o300);
      // Node's public opendir API cannot enumerate a FileHandle. Path-based
      // enumeration therefore relies on the same no-concurrent-writer precondition.
      const directory = await opendir(path);
      for await (const entry of directory) await visit(join(path, entry.name), depth + 1);
    } finally {
      await handle.close();
    }
  }
  await visit(allocated, 0);
}

/** Separate subject scratch from evaluator storage when a native runtime needs it. */
export async function createTrialPaths(storageRoot: string, subjectRoot?: string): Promise<TrialPaths> {
  const storage = resolve(storageRoot);
  if (subjectRoot !== undefined && (!isAbsolute(subjectRoot) || resolve(subjectRoot) !== subjectRoot ||
      contains(subjectRoot, storage) || contains(storage, subjectRoot))) {
    throw new Error('Subject scratch must be an absolute root disjoint from evaluator storage');
  }
  await mkdir(storage, { recursive: true, mode: 0o700 });
  if (subjectRoot !== undefined) {
    await mkdir(subjectRoot, { recursive: true, mode: 0o700 });
    const actualStorage = await realpath(storage);
    if (contains(subjectRoot, actualStorage) || contains(actualStorage, subjectRoot)) {
      throw new Error('Subject scratch overlaps the resolved evaluator storage');
    }
    const info = await lstat(subjectRoot);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(subjectRoot) !== subjectRoot) {
      throw new Error('Subject scratch must be a real directory without symlink traversal');
    }
  }
  const root = await mkdtemp(join(storage, 'trial-'));
  const native = subjectRoot === undefined ? root : await mkdtemp(join(subjectRoot, 'trial-'));
  const paths = { root, workspace: join(native, 'workspace'), control: join(root, 'control'), runtimeHome: join(root, 'runtime') };
  await Promise.all([paths.workspace, paths.control, paths.runtimeHome].map(path => mkdir(path, { mode: 0o700 })));
  return paths;
}

/** Only caller-allocated scratch is ephemeral; reports/control stay in the store. */
export async function releaseTrialScratch(paths: TrialPaths, subjectRoot: string | undefined, nativeClosed: boolean): Promise<void> {
  if (subjectRoot === undefined || !nativeClosed) return;
  const allocated = dirname(paths.workspace);
  if (dirname(allocated) !== subjectRoot || !allocated.startsWith(join(subjectRoot, 'trial-'))) {
    throw new Error('Refusing to remove unowned subject scratch');
  }
  await makeScratchRemovable(allocated);
  await rm(allocated, { recursive: true, force: true });
}
