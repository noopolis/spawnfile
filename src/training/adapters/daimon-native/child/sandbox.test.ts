import { afterEach, expect, it, vi } from 'vitest';
import { access, chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { childFixture } from './fixture.js';
import { writeSandboxProjectionFixture } from '../test-fixtures.js';
import { verifyChildSandbox } from './sandbox.js';
const behavior = vi.hoisted(() => ({ mode: 'complete' }));
vi.mock('node:child_process', () => ({ execFile: vi.fn((...args: unknown[]) => {
  const callback = args.at(-1) as (error: Error | null, stdout?: string, stderr?: string) => void;
  if (behavior.mode === 'error') { callback(new Error('private provider detail')); return; }
  const code = (args[1] as string[]).at(-1)!;
  const file = JSON.parse(/fs\.writeFileSync\(("(?:[^"\\]|\\.)*")/u.exec(code)![1]!);
  void import('node:fs/promises').then(async fs => {
    if (behavior.mode === 'connect') {
      const net = await import('node:net'); const port = Number(/port:(\d+)/u.exec(code)![1]);
      await new Promise<void>((resolve, reject) => { const socket = net.connect({ host: '127.0.0.1', port }); socket.on('error', reject); socket.on('close', () => resolve()); });
    }
    if (behavior.mode !== 'missing') await fs.writeFile(file, ['complete', 'connect'].includes(behavior.mode) ? 'NATIVE_POLICY_COMPLETE' : 'WRONG');
    callback(null, '', '');
  }).catch(callback);
}) }));
const roots: string[] = [];
afterEach(async () => { behavior.mode = 'complete'; vi.restoreAllMocks(); vi.clearAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const f = await childFixture(); roots.push(f.root); await writeSandboxProjectionFixture(f.launch, f.input.trialId); return f; }
it('uses exact persisted projection, denies protected paths and requires a completed durable proof', async () => {
  const f = await fixture(); await verifyChildSandbox(f.launch, f.input.trialId, f.input.protectedPaths!, new AbortController().signal);
  const receipt = JSON.parse(await readFile(join(f.launch.controlRoot, 'child-sandbox-preflight.json'), 'utf8'));
  expect(receipt).toMatchObject({ trialId: f.input.trialId, configSha256: f.launch.configSha256, modelCallsMade: 0, protectedPathsDenied: true, networkDenied: true });
  expect(execFile).toHaveBeenCalledWith('/unit/codex', expect.arrayContaining(['sandbox', '-P', 'unit', '-C', f.launch.workspace.target]), expect.any(Object), expect.any(Function));
  await expect(access(join(f.launch.projections[0]!.target, '.codex/auth.json'))).rejects.toThrow();
});
it.each(['missing', 'wrong', 'error'])('rejects incomplete or failed native enforcement: %s', async mode => {
  const f = await fixture(); behavior.mode = mode;
  await expect(verifyChildSandbox(f.launch, f.input.trialId, [], new AbortController().signal)).rejects.toThrow('failed before cognition');
  await expect(access(join(f.launch.controlRoot, 'child-sandbox-preflight.json'))).rejects.toThrow();
});
it('preserves existing opaque auth and rejects unsafe protected paths or mismatched projections', async () => {
  const f = await fixture(); const auth = join(f.launch.projections[0]!.target, '.codex/auth.json');
  await mkdir(join(f.launch.projections[0]!.target, '.codex'), { mode: 0o700 }); await writeFile(auth, 'opaque-unit-auth', { mode: 0o600 });
  await verifyChildSandbox(f.launch, f.input.trialId, [f.launch.config], new AbortController().signal);
  expect(await readFile(auth, 'utf8')).toBe('opaque-unit-auth');
  await expect(verifyChildSandbox(f.launch, 'wrong-trial', [], new AbortController().signal)).rejects.toThrow('not bound');
  const link = join(f.root, 'protected-link'); await symlink(f.launch.config, link);
  await expect(verifyChildSandbox(f.launch, f.input.trialId, [link], new AbortController().signal)).rejects.toThrow('before cognition');
});

it('has a reachable outside-sandbox network control and fails on credential canary creation errors', async () => {
  const f = await fixture(); behavior.mode = 'connect';
  await verifyChildSandbox(f.launch, f.input.trialId, [], new AbortController().signal);
  const g = await fixture(); const directory = join(g.launch.projections[0]!.target, '.codex');
  await mkdir(directory, { mode: 0o500 }); await chmod(directory, 0o500);
  await expect(verifyChildSandbox(g.launch, g.input.trialId, [], new AbortController().signal)).rejects.toThrow('failed before cognition');
});
