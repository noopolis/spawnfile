import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createTrialPaths, releaseTrialScratch } from './paths.js';
import { runTrial } from './trial.js';
import { setup, complete } from './fixture.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
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
  await expect(stat(paths.workspace)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await stat(paths.control)).isDirectory()).toBe(true);
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
