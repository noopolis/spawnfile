import { expect, test } from 'vitest';
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireNativeAccountLease } from './account-lease.js';
import { spawn } from 'node:child_process';

test('sequential native hosts share rotated state and overlapping admission waits', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-account-')));
  const release = await acquireNativeAccountLease(root);
  let next: (() => void) | undefined;
  try {
    await writeFile(join(root, 'auth.json'), 'generation-1', { mode: 0o600 });
    let entered = false;
    const queued = acquireNativeAccountLease(root).then(close => { entered = true; next = close; });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(entered).toBe(false);
    await writeFile(join(root, 'auth.json'), 'generation-2');
    release();
    await queued;
    expect(await readFile(join(root, 'auth.json'), 'utf8')).toBe('generation-2');
    next!(); next = undefined;
    const resumed = await acquireNativeAccountLease(root);
    expect(await readFile(join(root, 'auth.json'), 'utf8')).toBe('generation-2');
    resumed();
  } finally { release(); next?.(); await rm(root, { recursive: true, force: true }); }
});

test('cancelling and timing out waiters cannot release an active account owner', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-account-cancel-')));
  const release = await acquireNativeAccountLease(root);
  try {
    const cancel = new AbortController();
    const pending = acquireNativeAccountLease(root, cancel.signal);
    const rejected = expect(pending).rejects.toThrow();
    cancel.abort(); await rejected;
    await expect(acquireNativeAccountLease(root, undefined, 30)).rejects.toThrow('wait bound');
    await expect(acquireNativeAccountLease(root, undefined, 0)).rejects.toThrow('wait bound');
    release();
    const next = await acquireNativeAccountLease(root); next();
  } finally { release(); await rm(root, { recursive: true, force: true }); }
});

test('unsafe account and lease paths fail closed', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-account-paths-')));
  try {
    await chmod(root, 0o755);
    await expect(acquireNativeAccountLease(root)).rejects.toThrow('Unsafe native account');
    await chmod(root, 0o700);
    await symlink(join(root, 'elsewhere'), join(root, '.training-host.sqlite'));
    await expect(acquireNativeAccountLease(root)).rejects.toThrow('Unsafe native account');
    await expect(acquireNativeAccountLease(root, undefined, -1)).rejects.toThrow('wait bound');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cross-process ownership survives waiting cancellation and releases when the owner dies', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-account-process-')));
  const initialize = await acquireNativeAccountLease(root); initialize();
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    "import{DatabaseSync}from'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN EXCLUSIVE');process.stdout.write('owned\\n');setInterval(()=>{},1000);",
    join(root, '.training-host.sqlite')], { stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('owner did not acquire')), 2000);
      child.stdout!.once('data', bytes => { clearTimeout(timer); if (String(bytes) === 'owned\n') resolve(); else reject(new Error('invalid owner signal')); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    const cancel = new AbortController();
    const waiting = expect(acquireNativeAccountLease(root, cancel.signal)).rejects.toThrow();
    cancel.abort(); await waiting;
    await expect(acquireNativeAccountLease(root, undefined, 30)).rejects.toThrow('wait bound');
    child.kill('SIGKILL'); await exited;
    const resumed = await acquireNativeAccountLease(root, undefined, 1000); resumed();
  } finally { child.kill('SIGKILL'); await exited; await rm(root, { recursive: true, force: true }); }
});
