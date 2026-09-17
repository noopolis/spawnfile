import { chmod, lstat, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/** Lets one test act between the root check and the directory the call actually writes into. */
let betweenCheckAndCreate: (() => Promise<void>) | undefined;
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdtemp: async (prefix: string) => { const created = await actual.mkdtemp(prefix); await betweenCheckAndCreate?.(); return created; } };
});
afterEach(() => { betweenCheckAndCreate = undefined; });
import { fakeGrantAuthority } from './grant-fixtures.js';
import { prepareGrokGrantCall } from './grant-home.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'paideia-grant-home-')); await chmod(root, 0o700); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const grant = async () => { const fake = fakeGrantAuthority(); return { fake, grant: await fake.authority.request({ model: 'grok-4.5', reasoningEffort: 'high', purpose: 'optimizer' }) }; };

it('refuses a relative root and removes a partially provisioned call directory', async () => {
  const { fake, grant: issued } = await grant();
  await expect(prepareGrokGrantCall('src', fake.authority, issued, 'p')).rejects.toMatchObject({ kind: 'unsupported' });
  await expect(prepareGrokGrantCall(root, fake.authority, issued, undefined as unknown as string)).rejects.toThrow();
  expect(await readdir(root)).toEqual([]);
});

it('supplies a minimal PATH when the parent has none and never copies ambient credentials or homes', async () => {
  const { fake, grant: issued } = await grant();
  const saved = { PATH: process.env['PATH'], XAI_API_KEY: process.env['XAI_API_KEY'] };
  delete process.env['PATH']; process.env['XAI_API_KEY'] = 'ambient-secret';
  try {
    const call = await prepareGrokGrantCall(root, fake.authority, issued, 'p');
    expect(call.env).toEqual({ PATH: '/usr/local/bin:/usr/bin:/bin', HOME: call.work, TMPDIR: call.work, GROK_HOME: path.join(path.dirname(call.work), 'home'), DAIMON_INFERENCE_GRANT: issued.token });
    await call.cleanup();
    expect(await readdir(root)).toEqual([]);
  } finally {
    process.env['PATH'] = saved.PATH;
    delete process.env['XAI_API_KEY'];
  }
});

it('requires a private 0700 root owned by this user and refuses group- or world-readable ones', async () => {
  const { fake, grant: issued } = await grant();
  for (const mode of [0o750, 0o755, 0o770, 0o777, 0o500]) {
    await chmod(root, mode);
    await expect(prepareGrokGrantCall(root, fake.authority, issued, 'p')).rejects.toMatchObject({ kind: 'unsupported', message: expect.stringContaining('mode 0700') });
  }
  await chmod(root, 0o700);
  const call = await prepareGrokGrantCall(root, fake.authority, issued, 'p');
  await call.cleanup();
});

it('refuses a root swapped between its check and the directory the call writes into', async () => {
  const { fake, grant: issued } = await grant();
  const original = await lstat(root);
  betweenCheckAndCreate = async () => {
    await rename(root, `${root}-moved`);
    await mkdir(root, { mode: 0o700 });
  };
  await expect(prepareGrokGrantCall(root, fake.authority, issued, 'p')).rejects.toMatchObject({ kind: 'unsupported', message: expect.stringContaining('changed while preparing') });
  expect((await lstat(root)).ino).not.toBe(original.ino);
  expect(await readdir(root)).toEqual([]);
  await rm(`${root}-moved`, { recursive: true, force: true });
});

