import { afterEach, expect, it, vi } from 'vitest';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { join, relative } from 'node:path';
import { runInNewContext } from 'node:vm';
import { launchFixture, writeSandboxProjectionFixture } from '../test-fixtures.js';
import { verifyChildSandbox } from './sandbox.js';

const policy = vi.hoisted(() => ({ readable: '', attempted: [] as string[], allowSecret: false }));
// Unit policy evidence only: no native sandbox or real loopback enforcement claim.
vi.mock('node:net', () => ({ createServer: () => ({
  listen: (_port: number, _host: string, ready: () => void) => ready(),
  address: () => ({ port: 1234 }), close() {},
}) }));
vi.mock('node:child_process', () => ({ execFile: vi.fn((...args: unknown[]) => {
  const callback = args.at(-1) as (error: Error | null, stdout?: string, stderr?: string) => void;
  const socket = Object.assign(new EventEmitter(), { destroy() {}, setTimeout() {} });
  try {
    // Execute the exact generated probe with a policy denying every protected path
    // except, in the negative case, the actual configured evaluator secret leaf.
    runInNewContext((args[1] as string[]).at(-1)!, {
      require: (name: string) => name === 'node:fs' ? {
        readFileSync, writeFileSync, closeSync,
        openSync: (path: string, flags: string) => {
          policy.attempted.push(path);
          if (policy.allowSecret && path === policy.readable) return openSync(path, flags);
          throw Error('Denied by test policy');
        },
      } : { connect: () => socket },
      process: { exitCode: 0 },
    });
    socket.emit('error', new Error('Network denied by test policy'));
    callback(null, '', '');
  } catch { callback(new Error('Native policy probe failed')); }
}) }));

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs(); vi.clearAllMocks(); policy.attempted = []; policy.allowSecret = false; policy.readable = '';
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const f = await launchFixture(); roots.push(f.root);
  f.launch.workspace.target = f.launch.workspace.source;
  for (const row of f.launch.projections) row.target = row.source;
  await writeSandboxProjectionFixture(f.launch, f.input.trialId);
  policy.readable = join(f.root, 'evaluator-typesafe-secret');
  await writeFile(policy.readable, 'SYNTHETIC_SECRET_BYTES', { mode: 0o600 });
  vi.stubEnv('PAIDEIA_TYPESAFE_SECRET_FILE', policy.readable);
  return f;
}

it.each(['absolute', 'relative'])('includes the %s evaluator secret in denied reads without reading or publishing its bytes', async kind => {
  const f = await fixture();
  if (kind === 'relative') vi.stubEnv('PAIDEIA_TYPESAFE_SECRET_FILE', relative(process.cwd(), policy.readable));
  await verifyChildSandbox(f.launch, f.input.trialId, [], new AbortController().signal);
  expect(policy.attempted).toContain(policy.readable);
  const receipt = await readFile(join(f.launch.controlRoot, 'child-sandbox-preflight.json'), 'utf8');
  expect(JSON.parse(receipt)).toMatchObject({ protectedPathsDenied: true, modelCallsMade: 0 });
  expect(receipt).not.toContain('SYNTHETIC_SECRET_BYTES');
});

it('fails before cognition when the policy permits only the evaluator secret leaf', async () => {
  const f = await fixture(); policy.allowSecret = true;
  await expect(verifyChildSandbox(f.launch, f.input.trialId, [], new AbortController().signal))
    .rejects.toThrow('Exact native child sandbox failed before cognition');
  expect(policy.attempted).toContain(policy.readable);
  await expect(access(join(f.launch.controlRoot, 'child-sandbox-preflight.json'))).rejects.toThrow();
});

it.each([undefined, ''])('keeps unconfigured evaluator secrets optional: %s', async value => {
  const f = await fixture(); vi.stubEnv('PAIDEIA_TYPESAFE_SECRET_FILE', value);
  await verifyChildSandbox(f.launch, f.input.trialId, [], new AbortController().signal);
  expect(policy.attempted).not.toContain(policy.readable);
});

it('skips an absent configured evaluator secret instead of failing unrelated runs', async () => {
  const f = await fixture(); const missing = join(f.launch.controlRoot, 'absent-typesafe-secret');
  vi.stubEnv('PAIDEIA_TYPESAFE_SECRET_FILE', missing);
  await verifyChildSandbox(f.launch, f.input.trialId, [], new AbortController().signal);
  expect(policy.attempted).not.toContain(missing);
});

it('fails closed when the configured evaluator secret cannot be inspected', async () => {
  const f = await fixture(); const blocked = join(f.launch.config, 'typesafe');
  vi.stubEnv('PAIDEIA_TYPESAFE_SECRET_FILE', blocked);
  await expect(verifyChildSandbox(f.launch, f.input.trialId, [], new AbortController().signal)).rejects.toMatchObject({ message: 'Exact native child sandbox failed before cognition', cause: { code: 'ENOTDIR' } });
});
