import { afterEach, expect, test, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareTrainingCodexAuthority } from './trainingCodexAuthority.js';
import { stageTrainingAuth } from './trainingAuth.js';
import { DAIMON_CODEX_SUBSCRIPTION_REALM } from '../runtime/daimon/contractManifest.js';

const original = { ...DAIMON_CODEX_SUBSCRIPTION_REALM };
afterEach(() => { vi.unstubAllEnvs(); Object.assign(DAIMON_CODEX_SUBSCRIPTION_REALM, original); });

test('repeated training launches retain the same account and refreshed bytes outside trial output', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'training-codex-account-')));
  try {
    vi.stubEnv('SPAWNFILE_HOME', join(root, 'state'));
    const source = join(root, 'bootstrap'); await writeFile(source, 'opaque-bootstrap', { mode: 0o600 });
    const first = await prepareTrainingCodexAuthority(source, 'local');
    await writeFile(join(first, 'auth.json'), 'rotated-generation', { mode: 0o600 });
    expect(await prepareTrainingCodexAuthority(source, 'local')).toBe(first);
    expect(await readFile(join(first, 'auth.json'), 'utf8')).toBe('rotated-generation');
    await chmod(first, 0o755);
    await expect(prepareTrainingCodexAuthority(source, 'local')).rejects.toThrow('Unsafe training Codex account');
    await chmod(first, 0o700);
    await chmod(source, 0o644);
    await expect(prepareTrainingCodexAuthority(source, 'local')).rejects.toThrow('Unsafe training Codex bootstrap');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('legacy trial staging verifies the one bootstrap and never creates home-local copies', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'training-codex-ingress-')));
  try {
    const source = join(root, 'bootstrap'); await writeFile(source, 'opaque-bootstrap', { mode: 0o600 });
    Object.assign(DAIMON_CODEX_SUBSCRIPTION_REALM, { bootstrapMountPath: source });
    for (const name of ['first', 'second']) {
      const home = join(root, name); await mkdir(home, { mode: 0o700 });
      expect((await stageTrainingAuth({ provider: 'codex', home, source })).destination).toBe(source);
      await expect(readFile(join(home, '.daimon-inbound/codex-auth'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const other = join(root, 'different'); await writeFile(other, 'opaque-bootstrap', { mode: 0o600 });
    await expect(stageTrainingAuth({ provider: 'codex', home: root, source: other })).rejects.toThrow('differs');
    const alias = join(root, 'alias'); await symlink(source, alias);
    await expect(stageTrainingAuth({ provider: 'codex', home: root, source: alias })).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
