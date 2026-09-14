import { afterEach, expect, it } from 'vitest';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childDiagnostics } from './diagnostics.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await realpath(await mkdtemp(join(tmpdir(), 'native-diagnostics-'))); roots.push(root); return root; }

it('retains exact separate output and exit identity only in a private exclusive receipt', async () => {
  const root = await fixture(); const sink = await childDiagnostics(root, 'trial', 'a'.repeat(64));
  sink.append(Buffer.from('bootstrap progress\n'), true);
  sink.append(Buffer.from('{"schema":"paideia.daimon-native.start-failed.v1","error":"missing library"}\n'), false);
  await sink.save(1, null);
  expect((await lstat(sink.file)).mode & 0o777).toBe(0o600);
  const saved = await readFile(sink.file, 'utf8');
  expect(JSON.parse(saved)).toMatchObject({ schema: 'paideia.daimon-native.child-diagnostics.v1', trialId: 'trial', configSha256: 'a'.repeat(64),
    exitCode: 1, exitSignal: null, stdout: 'bootstrap progress\n', stderr: expect.stringContaining('missing library'), truncated: { stdout: false, stderr: false } });
  sink.append(Buffer.from('late'), false); await sink.save(9, 'SIGKILL');
  expect(await readFile(sink.file, 'utf8')).toBe(saved);
});
it('bounds each stream independently, including a single huge write', async () => {
  const sink = await childDiagnostics(await fixture(), 'trial', 'hash');
  sink.append(Buffer.alloc(70_000, 'x'), true); sink.append(Buffer.alloc(65_536, 'y'), false);
  sink.append(Buffer.from('discard'), true); sink.append(Buffer.from('discard'), false);
  await sink.save(null, 'SIGTERM'); const saved = JSON.parse(await readFile(sink.file, 'utf8'));
  expect(saved.stdout).toBe('x'.repeat(65_536)); expect(saved.stderr).toBe('y'.repeat(65_536));
  expect(saved.truncated).toEqual({ stdout: true, stderr: true }); expect(saved.exitSignal).toBe('SIGTERM');
});
it('refuses links, public directories and an existing diagnostic path without replacing bytes', async () => {
  const root = await fixture(); const target = join(root, 'target'); await mkdir(target, { mode: 0o700 });
  const alias = join(root, 'alias'); await symlink(target, alias);
  await expect(childDiagnostics(alias, 'trial', 'hash')).rejects.toThrow('protected');
  await chmod(target, 0o755); await expect(childDiagnostics(target, 'trial', 'hash')).rejects.toThrow('protected');
  const file = join(root, 'original'); await writeFile(file, 'preserve');
  await expect(childDiagnostics(file, 'trial', 'hash')).rejects.toThrow('protected');
  const sink = await childDiagnostics(root, 'trial', 'hash'); await symlink(file, sink.file);
  await expect(sink.save(1, null)).rejects.toThrow(); expect(await readFile(file, 'utf8')).toBe('preserve');
});
