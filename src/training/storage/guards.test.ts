import { mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertIdentity, digestName, jsonBytes } from './content.js';
import { initializeStoreRoot, immutableWrite, readStored, safeStorePath } from './filesystem.js';
import { appendJournal, readJournal } from './journal.js';
import { assertRunAccess, canReadVisibility, validateManifest, validateVisibility } from './permissions.js';
import type { ReadAccess, RunManifest, Visibility } from './types.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function temporary(): Promise<string> { const root = await mkdtemp(join(tmpdir(), 'paideia-guards-')); roots.push(root); return root; }
const manifest: RunManifest = { schema: 'paideia.run.v1', id: 'run', datasetId: 'd', datasetRole: 'train', candidateId: 'c', planDigest: 'p' };
describe('storage data and authorization guards', () => {
  it('only serializes finite, acyclic plain JSON with deterministic keys', () => {
    expect(jsonBytes({ z: undefined, b: [true, null, 1], A: 'text' })).toBe('{"A":"text","b":[true,null,1]}');
    expect(jsonBytes(Object.create(null))).toBe('{}');
    for (const value of [undefined, Infinity, 1n, new Date(), () => true, { fn: () => true }]) expect(() => jsonBytes(value)).toThrow(/JSON/);
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => jsonBytes(cyclic)).toThrow(/depth/);
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => { throw new Error('must not execute'); } });
    expect(() => jsonBytes(accessor)).toThrow(/accessors/);
    expect(() => assertIdentity('')).toThrow(/identity/);
    expect(() => assertIdentity('x'.repeat(513))).toThrow(/identity/);
    expect(() => assertIdentity('x\0y')).toThrow(/identity/);
    expect(() => digestName('../bad')).toThrow(/digest/);
  });
  it('rejects unknown schemas, roles, visibility and malformed phase authorization', () => {
    for (const value of [{ ...manifest, schema: 'bad' }, { ...manifest, datasetRole: 'future' }, { ...manifest, extra: true }, { ...manifest, recordId: '' }]) expect(() => validateManifest(value as RunManifest)).toThrow();
    expect(() => validateVisibility('secret' as Visibility)).toThrow(/visibility/);
    for (const access of [{ audience: 'anonymous', phase: 'training' }, { audience: 'viewer', phase: 'future' }]) expect(() => assertRunAccess(manifest, access as ReadAccess)).toThrow(/authorization/);
    expect(canReadVisibility('raw', { audience: 'operator', phase: 'replay' })).toBe(true);
    expect(canReadVisibility('evaluator', { audience: 'viewer', phase: 'replay' })).toBe(false);
    const test = { ...manifest, datasetRole: 'test' as const };
    expect(() => assertRunAccess(test, { audience: 'evaluator', phase: 'replay', frozenCandidateIds: ['c'], releaseTestResults: false })).toThrow(/Sealed/);
  });
});
describe('atomic files and append recovery', () => {
  it('never overwrites a published identity and never follows a symlink', async () => {
    const root = await temporary();
    const path = await safeStorePath(root, ['artifacts', 'one']);
    await immutableWrite(path, 'first');
    await immutableWrite(path, Buffer.from('first'));
    await expect(immutableWrite(path, 'changed')).rejects.toThrow(/Immutable/);
    expect((await readStored(path)).toString()).toBe('first');
    await symlink('artifacts', join(root, 'alias'));
    await expect(initializeStoreRoot(join(root, 'alias'))).rejects.toThrow(/plain directories/);
    await expect(safeStorePath(root, ['alias', 'one'])).rejects.toThrow(/symlink/);
    for (const parts of [['..'], ['a/b'], ['.'], ['']]) await expect(safeStorePath(root, parts)).rejects.toThrow(/Unsafe/);
    await expect(safeStorePath(root, [])).rejects.toThrow(/escapes/);
    await expect(readStored(join(root, 'artifacts'))).rejects.toThrow(/regular file/);
    await expect(readStored(join(root, 'absent'))).rejects.toThrow();
  });
  it('reports busy/stale writers explicitly without mutating the journal', async () => {
    const root = await temporary(); const path = join(root, 'events.jsonl');
    await writeFile(`${path}.lock`, 'stale');
    await expect(appendJournal(path, { id: 'x', payload: true }, 'raw')).rejects.toThrow(/busy/);
    expect(await readJournal(path)).toEqual({ events: [], ignoredTailBytes: 0, totalBytes: 0 });
    await expect(appendJournal(join(root, 'absent', 'events.jsonl'), { id: 'x', payload: null }, 'raw')).rejects.toThrow();
    await mkdir(join(root, 'directory'));
    await expect(readJournal(join(root, 'directory'))).rejects.toThrow(/regular file/);
  });
  it('enforces immutable blob size bounds and rejects oversized files before reading', async () => {
    const root = await temporary(); const path = join(root, 'huge');
    const file = await open(path, 'wx');
    try { await file.truncate(67_108_865); } finally { await file.close(); }
    await expect(readStored(path)).rejects.toThrow(/bounded regular/);
    await expect(immutableWrite(join(root, 'oversized'), new Uint8Array(67_108_865))).rejects.toThrow(/64 MiB/);
  });
});

it('rejects sparse arrays instead of writing a journal payload that cannot be parsed', () => {
  expect(() => jsonBytes(new Array(2))).toThrow(/JSON/);
});
