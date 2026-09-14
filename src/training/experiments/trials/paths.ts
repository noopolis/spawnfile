import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { TrialPaths } from './types.js';

const contains = (parent: string, child: string): boolean => {
  const name = relative(parent, child);
  return name === '' || name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name);
};

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
  await rm(allocated, { recursive: true, force: true });
}
