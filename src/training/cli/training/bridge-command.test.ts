import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { resolveTrainingBridgeCommand } from './bridge-command.js';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const setup = async () => { const root = await realpath(await mkdtemp(join(tmpdir(), 'bridge-command-'))); roots.push(root); return root; };
it('selects the first executable regular file in PATH and freezes PATH aliases while retaining explicit selections', async () => {
  const root = await setup(), first = join(root, 'first'), second = join(root, 'second');
  await mkdir(first); await mkdir(second);
  await mkdir(join(first, 'bridge'));
  await writeFile(join(second, 'bridge'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  vi.stubEnv('PATH', `${join(root, 'missing')}:${first}:${second}`);
  expect(await resolveTrainingBridgeCommand('bridge', root)).toBe(join(second, 'bridge'));
  await rm(join(first, 'bridge'), { recursive: true }); await writeFile(join(first, 'bridge'), '', { mode: 0o600 });
  expect(await resolveTrainingBridgeCommand('bridge', root)).toBe(join(second, 'bridge'));
  await chmod(join(first, 'bridge'), 0o700);
  expect(await resolveTrainingBridgeCommand('bridge', root)).toBe(join(first, 'bridge'));
  await symlink(join(first, 'bridge'), join(root, 'alias'));
  expect(await resolveTrainingBridgeCommand('./alias', root)).toBe(join(root, 'alias'));
  vi.stubEnv('PATH', root); expect(await resolveTrainingBridgeCommand('alias', root)).toBe(join(first, 'bridge'));
  expect(await resolveTrainingBridgeCommand(join(first, 'bridge'), root)).toBe(join(first, 'bridge'));
});
it('uses the launch cwd for relative and empty PATH entries and refuses unavailable commands', async () => {
  const root = await setup(); await mkdir(join(root, 'bin'));
  await writeFile(join(root, 'bin/bridge'), '', { mode: 0o700 });
  vi.stubEnv('PATH', 'bin'); expect(await resolveTrainingBridgeCommand('bridge', root)).toBe(join(root, 'bin/bridge'));
  vi.stubEnv('PATH', ''); await expect(resolveTrainingBridgeCommand('bridge', root)).rejects.toThrow('unavailable');
  await writeFile(join(root, 'bridge'), '', { mode: 0o700 });
  expect(await resolveTrainingBridgeCommand('bridge', root)).toBe(join(root, 'bridge'));
  vi.stubEnv('PATH', undefined); await expect(resolveTrainingBridgeCommand('bridge', root)).rejects.toThrow('unavailable');
  await expect(resolveTrainingBridgeCommand('absent', root)).rejects.toThrow('unavailable');
  vi.stubEnv('PATH', join(root, 'bridge')); await expect(resolveTrainingBridgeCommand('child', root)).rejects.toThrow('unavailable');
  vi.stubEnv('PATH', root); await symlink('loop', join(root, 'loop')); await expect(resolveTrainingBridgeCommand('loop', root)).rejects.toMatchObject({ code: 'ELOOP' });
});
