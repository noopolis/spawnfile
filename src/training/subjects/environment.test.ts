import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { canonicalProtectedPaths, prepareCodexEnvironment, savedCodexHome, within } from './environment.js';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'paideia-auth-boundary-')); roots.push(root);
  await mkdir(path.join(root, 'auth'));
  await writeFile(path.join(root, 'auth', 'auth.json'), '{}');
  return root;
}

it('selects saved external authentication and strips API/host environment secrets', async () => {
  const root = await fixture();
  vi.stubEnv('CODEX_HOME', path.join(root, 'auth'));
  vi.stubEnv('OPENAI_API_KEY', 'must-not-inherit');
  vi.stubEnv('PAIDEIA_PRIVATE_LABEL', 'must-not-inherit');
  expect(savedCodexHome()).toBe(path.join(root, 'auth'));
  expect(savedCodexHome('/explicit')).toBe('/explicit');
  const env = await prepareCodexEnvironment(path.join(root, 'workspace'), path.join(root, 'runtime'), savedCodexHome());
  expect(env['CODEX_HOME']).toBe(await import('node:fs/promises').then((fs) => fs.realpath(path.join(root, 'auth'))));
  expect(env['OPENAI_API_KEY']).toBeUndefined();
  expect(env['PAIDEIA_PRIVATE_LABEL']).toBeUndefined();
  vi.stubEnv('CODEX_HOME', undefined);
  expect(savedCodexHome()).toMatch(/\.codex$/u);
});

it('rejects auth in either subject-writable root including symlink aliases', async () => {
  const root = await fixture();
  await expect(prepareCodexEnvironment(root, path.join(root, 'runtime'), path.join(root, 'auth'))).rejects.toThrow('outside');
  await symlink(path.join(root, 'auth'), path.join(root, 'alias'));
  await expect(prepareCodexEnvironment(path.join(root, 'workspace'), path.join(root, 'auth'), path.join(root, 'alias'))).rejects.toThrow('outside');
  await expect(prepareCodexEnvironment(path.join(root, 'workspace'), path.join(root, 'runtime'), '/missing-auth')).rejects.toThrow();
  await expect(prepareCodexEnvironment(path.join(root, 'auth', 'workspace'), path.join(root, 'runtime'), path.join(root, 'auth'))).rejects.toThrow('outside');
  await expect(prepareCodexEnvironment(path.join(root, 'workspace'), path.join(root, 'auth', 'runtime'), path.join(root, 'auth'))).rejects.toThrow('outside');
  expect(await canonicalProtectedPaths([path.join(root, 'alias')])).toEqual(await canonicalProtectedPaths([path.join(root, 'auth')]));
  await expect(canonicalProtectedPaths(['relative'])).rejects.toThrow('absolute');
  await expect(canonicalProtectedPaths(['/nonexistent-protected-root'])).rejects.toThrow();
});

it('uses path containment rather than string prefixes', () => {
  expect(within('/a', '/a')).toBe(true);
  expect(within('/a', '/a/b')).toBe(true);
  expect(within('/a', '/ab')).toBe(false);
  expect(within('/a/b', '/a')).toBe(false);
});
