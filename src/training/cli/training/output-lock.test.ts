import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reserveOutput } from './output-lock.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, chmod: vi.fn(actual.chmod) };
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'paideia-lock-')); roots.push(root); return root; }

it('excludes another owner and releases on completion without stale lock files', async () => {
  const root = await fixture();
  const release = await reserveOutput(root);
  try {
    expect((await stat(join(root, '.invocation-lock.sqlite'))).mode & 0o777).toBe(0o600);
    await expect(reserveOutput(root)).rejects.toThrow('reserved by another command');
  } finally { release(); }
  const second = await reserveOutput(root); second();
});

it('rejects symbolic output lock paths before opening a database', async () => {
  const root = await fixture();
  await symlink(join(root, 'outside'), join(root, '.invocation-lock.sqlite'));
  await expect(reserveOutput(root)).rejects.toThrow('cannot be a symlink');
});

it('keeps permission and IO failures distinct from a competing owner and closes the handle', async () => {
  const root = await fixture();
  for (const failure of [new Error('permission denied'), 'storage unavailable']) {
    vi.mocked(chmod).mockRejectedValueOnce(failure);
    await expect(reserveOutput(root)).rejects.toThrow(/Output lock unavailable:/);
    const release = await reserveOutput(root); release();
  }
});

it('recovers a real killed process holding a transaction without stealing a live lock', async () => {
  const root = await fixture();
  const module = new URL('./output-lock.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `const {reserveOutput}=await import(${JSON.stringify(module)}); await reserveOutput(process.argv[1]); console.log('LOCK_HELD'); setInterval(()=>{},1000);`, root],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const started = new Promise<void>((resolve, reject) => {
    child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('LOCK_HELD')) resolve(); });
    child.once('error', reject);
    child.once('exit', () => reject(new Error(`Lock child exited before sentinel: ${output}`)));
  });
  try {
    await started;
    await expect(reserveOutput(root)).rejects.toThrow('reserved');
  } finally { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  const release = await reserveOutput(root); release();
}, 15000);
