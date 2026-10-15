import { afterEach, expect, it, vi } from 'vitest';
import { constants } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, open, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createTrialPaths, releaseTrialScratch } from './paths.js';
import { runTrial } from './trial.js';
import { setup, complete } from './fixture.js';

const roots: string[] = [];
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
afterEach(async () => {
  vi.mocked(open).mockReset();
  vi.mocked(open).mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open);
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function root() { const value = await realpath(await mkdtemp(join(tmpdir(), 'paideia-paths-'))); roots.push(value); return value; }

it('preserves default paths and separates only subject scratch when explicitly selected', async () => {
  const base = await root();
  const ordinary = await createTrialPaths(join(base, 'store'));
  expect(dirname(ordinary.workspace)).toBe(ordinary.root);
  const paths = await createTrialPaths(join(base, 'store'), join(base, 'subjects'));
  expect(paths.workspace.startsWith(join(base, 'subjects/trial-'))).toBe(true);
  expect(dirname(paths.control)).toBe(paths.root);
  expect(dirname(paths.runtimeHome)).toBe(paths.root);
  expect((await stat(paths.workspace)).mode & 0o777).toBe(0o700);
  const next = await createTrialPaths(join(base, 'store'), join(base, 'subjects'));
  expect(next.workspace).not.toBe(paths.workspace);
});

it('rejects aliases, relative scratch, overlapping roots and escaped cleanup', async () => {
  const base = await root(); const store = join(base, 'store');
  for (const scratch of ['relative', base, store, join(store, 'nested'), `${base}/a/../subjects`]) {
    await expect(createTrialPaths(store, scratch)).rejects.toThrow('disjoint');
  }
  await symlink(base, join(base, 'alias'));
  await expect(createTrialPaths(store, join(base, 'alias/subjects'))).rejects.toThrow('real directory');
  await mkdir(join(base, 'actual-storage'));
  await symlink(join(base, 'actual-storage'), join(base, 'storage-alias'));
  await expect(createTrialPaths(join(base, 'storage-alias'), join(base, 'actual-storage/subjects'))).rejects.toThrow('resolved evaluator storage');
  const paths = await createTrialPaths(store);
  await expect(releaseTrialScratch(paths, join(base, 'subjects'), true)).rejects.toThrow('unowned');
});

it('cleans scratch only after confirmed closure, retaining durable control and default workspaces', async () => {
  const base = await root(); const subjects = join(base, 'subjects');
  const paths = await createTrialPaths(join(base, 'store'), subjects);
  await writeFile(join(paths.workspace, 'result'), 'captured');
  await releaseTrialScratch(paths, subjects, false);
  expect((await stat(paths.workspace)).isDirectory()).toBe(true);
  await releaseTrialScratch(paths, undefined, true);
  expect((await stat(paths.workspace)).isDirectory()).toBe(true);
  await releaseTrialScratch(paths, subjects, true);
  await releaseTrialScratch(paths, subjects, true);
  await expect(stat(paths.workspace)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await stat(paths.control)).isDirectory()).toBe(true);
});

it('releases read-only scratch trees without following external directory or file symlinks', async () => {
  const base = await root(); const subjects = join(base, 'subjects');
  const paths = await createTrialPaths(join(base, 'store'), subjects);
  const outside = join(base, 'outside'); const outsideFile = join(outside, 'keep');
  const repo = join(paths.workspace, 'repos', 'newsroom');
  await mkdir(repo, { recursive: true });
  await mkdir(outside);
  await writeFile(outsideFile, 'untouched');
  await writeFile(join(repo, '.gitignore'), 'read-only resource');
  await chmod(join(repo, '.gitignore'), 0o444);
  await symlink(outside, join(repo, 'external-directory'));
  await symlink(outsideFile, join(repo, 'external-file'));
  await symlink(join(outside, 'missing'), join(repo, 'dangling'));
  const directories = [dirname(paths.workspace), paths.workspace, dirname(repo), repo, outside];
  for (const directory of directories) await chmod(directory, 0o555);
  await chmod(outsideFile, 0o444);
  try {
    await releaseTrialScratch(paths, subjects, false);
    expect((await stat(repo)).mode & 0o777).toBe(0o555);
    await releaseTrialScratch(paths, subjects, true);
    await expect(stat(dirname(paths.workspace))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(outside)).mode & 0o777).toBe(0o555);
    expect((await stat(outsideFile)).mode & 0o777).toBe(0o444);
    expect((await stat(paths.control)).isDirectory()).toBe(true);
  } finally {
    for (const directory of directories) {
      await chmod(directory, 0o700).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
});

it('reports foreign-owned directories without widening their permissions', async () => {
  const base = await root(); const subjects = join(base, 'subjects');
  const paths = await createTrialPaths(join(base, 'store'), subjects);
  await chmod(paths.workspace, 0o555);
  const uid = process.getuid!();
  const owner = vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
  try {
    await expect(releaseTrialScratch(paths, subjects, true)).rejects.toThrow('another uid');
    expect((await stat(paths.workspace)).mode & 0o777).toBe(0o555);
  } finally {
    owner.mockRestore();
    await chmod(paths.workspace, 0o700);
  }
});

it('chmods the checked inode when its path becomes an external symlink after fstat', async () => {
  const base = await root(); const subjects = join(base, 'subjects');
  const paths = await createTrialPaths(join(base, 'store'), subjects);
  const outside = join(base, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'keep'), 'untouched');
  await chmod(outside, 0o555);
  await chmod(paths.workspace, 0o555);
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let swapped = false;
  vi.mocked(open).mockImplementation(async (path, flags, mode) => {
    const handle = await actual.open(path, flags, mode);
    if (path === paths.workspace) {
      expect(flags).toBe(constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const fstat = handle.stat.bind(handle);
      vi.spyOn(handle, 'stat').mockImplementationOnce(async () => {
        const checked = await fstat();
        await rename(paths.workspace, `${paths.workspace}-checked`);
        await symlink(outside, paths.workspace);
        swapped = true;
        return checked;
      });
    }
    return handle;
  });
  try {
    await releaseTrialScratch(paths, subjects, true);
    expect(swapped).toBe(true);
    expect((await stat(outside)).mode & 0o777).toBe(0o555);
    expect((await stat(join(outside, 'keep'))).isFile()).toBe(true);
  } finally {
    await chmod(outside, 0o700);
  }
});

it.each(['symlink', 'hardlink', 'directory'] as const)('rejects a %s replacement between the walk check and open', async replacement => {
  const base = await root(); const subjects = join(base, 'subjects');
  const paths = await createTrialPaths(join(base, 'store'), subjects);
  const outside = join(base, 'outside');
  if (replacement === 'hardlink') await writeFile(outside, 'untouched');
  else await mkdir(outside);
  await chmod(outside, 0o555);
  await chmod(paths.workspace, 0o555);
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(open).mockImplementation(async (path, flags, mode) => {
    if (path === paths.workspace) {
      await rename(paths.workspace, `${paths.workspace}-checked`);
      if (replacement === 'symlink') await symlink(outside, paths.workspace);
      else if (replacement === 'hardlink') await link(outside, paths.workspace);
      else { await mkdir(paths.workspace); await chmod(paths.workspace, 0o555); }
    }
    return actual.open(path, flags, mode);
  });
  try {
    await expect(releaseTrialScratch(paths, subjects, true)).rejects.toThrow();
    expect((await stat(outside)).mode & 0o777).toBe(0o555);
    if (replacement === 'directory') expect((await stat(paths.workspace)).mode & 0o777).toBe(0o555);
  } finally {
    await chmod(outside, 0o700);
    await chmod(`${paths.workspace}-checked`, 0o700);
    if (replacement === 'directory') await chmod(paths.workspace, 0o700);
  }
});

it('bounds permission traversal depth', async () => {
  const base = await root(); const subjects = join(base, 'subjects');
  const paths = await createTrialPaths(join(base, 'store'), subjects);
  let nested = paths.workspace;
  for (let depth = 0; depth < 256; depth++) nested = join(nested, 'd');
  await mkdir(nested, { recursive: true });
  await expect(releaseTrialScratch(paths, subjects, true)).rejects.toThrow('entry/depth limit');
  expect((await stat(paths.workspace)).isDirectory()).toBe(true);
});

it('passes the real separated workspace through preparation and native start, captures before cleanup', async () => {
  const base = await root(); const subjects = join(base, 'subjects');
  const fixture = await setup(async input => {
    expect(input.workspacePath.startsWith(subjects + '/')).toBe(true);
    expect(input.protectedPaths).toContain(input.runtimeHomePath);
    await writeFile(join(input.workspacePath, 'answer.txt'), 'captured output');
    return complete;
  });
  fixture.options.root = join(base, 'store'); fixture.options.subjectRoot = subjects;
  fixture.options.record.outputs = { answer: 'answer.txt' };
  const report = await runTrial(fixture.options);
  expect(report.status).toBe('pass');
  expect(report.snapshot.artifacts.answer?.bytes).toBe('captured output');
  await expect(stat(report.paths.workspace)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(fixture.journal.at(-1)?.type).toBe('trial.completed');
});
