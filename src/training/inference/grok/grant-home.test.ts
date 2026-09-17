import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
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
