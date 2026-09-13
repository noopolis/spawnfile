import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectOutputs, confinedFile, digest, readSelected, relativePath, stageInput } from './files.js';

const roots: string[] = [];
async function root() { const value = await mkdtemp(join(tmpdir(), 'paideia-files-')); roots.push(value); return value; }
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe('pinned trial material', () => {
  it('stages only selected current inputs and verifies hashes before delivery', async () => {
    const source = await root(); const workspace = await root();
    await writeFile(join(source, 'current.txt'), 'current'); await writeFile(join(source, 'future.txt'), 'future');
    const file = { resource: 'archive', path: 'current.txt', sha256: digest('current') };
    const known = {};
    const input = { prompt: 'Read', data: { task: 1 }, message: { id: 'request' }, files: [file] };
    expect(await stageInput(input, workspace, { archive: source }, known)).toContain('inputs/archive/current.txt');
    expect(await readFile(join(workspace, 'inputs/archive/current.txt'), 'utf8')).toBe('current');
    await expect(readFile(join(workspace, 'inputs/archive/future.txt'))).rejects.toThrow();
    await expect(stageInput(input, workspace, { archive: source }, known)).resolves.toContain('Read');
    await expect(stageInput(input, workspace, { archive: source }, { 'inputs/archive/current.txt': 'changed' })).rejects.toThrow('replaces');
    await expect(readSelected({ ...file, sha256: digest('wrong') }, { archive: source })).rejects.toThrow('changed');
    await expect(readSelected(file, {})).rejects.toThrow('Unmapped');
    expect(await stageInput({ prompt: 'only' }, workspace, {}, {})).toBe('only');
  });
  it('preserves original BOM bytes and rejects shared hard-linked output files', async () => {
    const source = await root(); const workspace = await root(); const bytes = '\uFEFForiginal';
    await writeFile(join(source, 'bom'), bytes);
    const file = { resource: 'a', path: 'bom', sha256: digest(bytes) };
    await stageInput({ files: [file] }, workspace, { a: source }, {});
    expect(await readFile(join(workspace, 'inputs/a/bom'), 'utf8')).toBe(bytes);
    expect((await collectOutputs({ bom: 'inputs/a/bom' }, workspace, 'capture')).bom!.digest).toBe(file.sha256);
    await link(join(source, 'bom'), join(source, 'linked'));
    await expect(readSelected(file, { a: source })).rejects.toThrow('private regular');
  });
  it('rejects path escapes and subject-created links before a later input is written', async () => {
    const source = await root(); const workspace = await root();
    await writeFile(join(source, 'data'), 'data'); await mkdir(join(source, 'directory'));
    await symlink(join(source, 'data'), join(source, 'link'));
    for (const path of ['', '/tmp/x', '../x', 'a/../x', 'a\\b', './x', 'a//b']) expect(() => relativePath(path)).toThrow();
    await expect(confinedFile(source, 'link')).rejects.toThrow('Symlink');
    await expect(confinedFile(source, 'directory')).rejects.toThrow('not a file');
    await symlink(source, join(workspace, 'inputs'));
    await expect(stageInput({ files: [{ resource: 'a', path: 'data', sha256: digest('data') }] }, workspace, { a: source }, {})).rejects.toThrow();
    await writeFile(join(source, 'invalid'), Buffer.from([0xff]));
    await expect(readSelected({ resource: 'a', path: 'invalid', sha256: digest(Buffer.from([0xff])) }, { a: source })).rejects.toThrow();
    const large = Buffer.alloc(32 * 1024 * 1024 + 1);
    await writeFile(join(source, 'large'), large);
    await expect(readSelected({ resource: 'a', path: 'large', sha256: digest(large) }, { a: source })).rejects.toThrow('32 MiB');
  });
  it('freezes output bytes without inventing accepted-filing lineage', async () => {
    const workspace = await root();
    await writeFile(join(workspace, 'a.json'), '{"body":"first"}'); await writeFile(join(workspace, 'b.txt'), 'text');
    const first = await collectOutputs({ article: 'a.json', text: 'b.txt', absent: 'absent' }, workspace, 'first');
    expect(first.article!.value).toEqual({ body: 'first' }); expect(first.article!.acceptedCallId).toBeUndefined();
    expect(first.text!.value).toBe('text'); expect(first.absent).toBeUndefined();
    await writeFile(join(workspace, 'a.json'), '{"body":"second"}');
    expect((await collectOutputs({ article: 'a.json' }, workspace, 'second')).article!.digest).not.toBe(first.article!.digest);
    expect(first.article!.bytes).toBe('{"body":"first"}');
    await symlink(join(workspace, 'a.json'), join(workspace, 'linked'));
    await expect(collectOutputs({ bad: 'linked' }, workspace, 'bad')).rejects.toThrow();
  });
});
