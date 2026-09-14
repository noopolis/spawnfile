import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { snapshotCandidate } from '../candidates/index.js';
import { openExperimentStore } from '../storage/index.js';
import { cliFixture } from './fixture.js';
import { persistResult, withOutput } from './output.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('local invocation evidence', () => {
  it('stores a training report only under test-role access and persists a reference-only index', async () => {
    const fixture = await cliFixture(); roots.push(fixture.root);
    const candidate = await snapshotCandidate({ sourceRoot: fixture.root, resources: [
      { id: 'instructions', sourcePath: 'AGENTS.md', destinations: [{ kind: 'instructions', path: 'AGENTS.md' }], edit: 'locked' },
    ] });
    const root = join(fixture.root, 'out');
    const report = { secret: 'SEALED TEST LABEL' };
    const index = await withOutput(root, (store) => persistResult({ root, store, id: 'summary', command: 'train',
      datasetId: 'held-out', planDigest: 'plan', candidate, report, trialIds: ['trial'] }));
    expect(index.phase).toBe('test');
    const bytes = await readFile(join(root, 'invocation.json'), 'utf8');
    expect(JSON.parse(bytes)).toEqual(index); expect(bytes).not.toContain('SEALED');
    expect((await stat(join(root, 'invocation.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, 'invocations'))).mode & 0o777).toBe(0o700);
    expect(await readFile(join(root, 'invocations', 'summary.json'), 'utf8')).toBe(bytes);
    const store = await openExperimentStore(root);
    await expect(store.readBlob(index.report, { audience: 'optimizer', phase: 'training' })).rejects.toThrow();
    await expect(store.readBlob(index.report, { audience: 'evaluator', phase: 'replay' })).rejects.toThrow('Sealed');
    const read = await store.readBlob(index.report, { audience: 'evaluator', phase: 'test', frozenCandidateIds: [candidate.id] });
    expect(JSON.parse(read.toString())).toEqual(report);
  });
  it('rejects reused or concurrently owned output directories before calling work', async () => {
    const fixture = await cliFixture(); roots.push(fixture.root);
    const operation = vi.fn(async () => undefined);
    await writeFile(join(fixture.root, 'invocation.json'), '{}');
    await expect(withOutput(fixture.root, operation)).rejects.toThrow('fresh --out');
    await expect(stat(join(fixture.root, '.invocation.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(join(fixture.root, '.invocation.lock'), 'owned');
    await expect(withOutput(fixture.root, operation)).rejects.toThrow('previous command stopped');
    expect(operation).not.toHaveBeenCalled();
  });
  it('releases its own output reservation after a failed operation', async () => {
    const fixture = await cliFixture(); roots.push(fixture.root);
    await expect(withOutput(fixture.root, async () => { throw new Error('sink unavailable'); })).rejects.toThrow('sink unavailable');
    await expect(stat(join(fixture.root, '.invocation.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails if the actual persisted invocation index is replaced before verification', async () => {
    const fixture = await cliFixture(); roots.push(fixture.root);
    const candidate = await snapshotCandidate({ sourceRoot: fixture.root, resources: [
      { id: 'instructions', sourcePath: 'AGENTS.md', destinations: [{ kind: 'instructions', path: 'AGENTS.md' }], edit: 'locked' },
    ] });
    const store = await openExperimentStore(fixture.root);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(readFile).mockImplementationOnce(async (path) => {
      await writeFile(path, 'tampered index');
      return actual.readFile(path, 'utf8');
    });
    await expect(persistResult({ root: fixture.root, store, id: 'summary', command: 'evaluate', datasetId: 'dataset',
      planDigest: 'plan', candidate, report: {}, trialIds: [] })).rejects.toThrow('did not persist faithfully');
    expect(await readFile(join(fixture.root, 'invocation.json'), 'utf8')).toBe('tampered index');
  });
});
