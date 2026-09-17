import { afterEach, expect, it, vi } from 'vitest';
import { access, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { childFixture } from './fixture.js';
import { verifyChildSandbox } from './sandbox.js';
import { grokLaunchFrom, grokProjectionFor, writeGrokProjectionReceipt } from '../grok-fixtures.js';
import { grokProjectionSha256 } from '../receipt/index.js';
vi.mock('node:child_process', () => ({ execFile: vi.fn(() => { throw new Error('Grok slot checks never run a local sandbox command'); }) }));
const roots: string[] = [];
afterEach(async () => { vi.clearAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const f = await childFixture(); roots.push(f.root);
  const launch = await grokLaunchFrom(f.launch, f.root);
  const projection = grokProjectionFor(launch, f.input.protectedPaths);
  launch.broker.projectionSha256 = grokProjectionSha256(projection); await f.save();
  return { ...f, launch, projection };
}
const preflight = (root: string) => join(root, 'child-sandbox-preflight.json');

it('accepts only the persisted supervisor receipt that denies every evaluator and caller-protected path, without a local probe', async () => {
  const f = await fixture();
  await writeGrokProjectionReceipt(f.launch, f.input.trialId, f.projection);
  await verifyChildSandbox(f.launch, f.input.trialId, f.input.protectedPaths!, new AbortController().signal);
  expect(execFile).not.toHaveBeenCalled();
  const receipt = JSON.parse(await readFile(preflight(f.launch.controlRoot), 'utf8'));
  expect(receipt).toMatchObject({ schema: 'paideia.daimon-native.child-grok-slot-preflight.v1', trialId: f.input.trialId, modelCallsMade: 0,
    localSandboxProbe: false, projectionSha256: f.launch.broker.projectionSha256 });
  expect(receipt.evaluatorPathsDenied).toEqual(expect.arrayContaining([...f.input.protectedPaths!, f.launch.controlRoot]));
});

it('fails closed without the slot receipt, for another trial, or when a caller-protected path lacks a denied canary', async () => {
  const f = await fixture();
  const verify = (paths = f.input.protectedPaths!, trial = f.input.trialId) => verifyChildSandbox(f.launch, trial, paths, new AbortController().signal);
  await expect(verify()).rejects.toThrow('Grok broker slot preflight failed before cognition');
  await writeGrokProjectionReceipt(f.launch, f.input.trialId, f.projection);
  await expect(verify(f.input.protectedPaths, 'other-trial')).rejects.toThrow('before cognition');
  const extra = join(f.root, 'extra-evaluator'); await writeFile(extra, 'sealed');
  const failure = await verify([...f.input.protectedPaths!, extra]).catch((error: Error) => error);
  expect(String((failure as Error).cause)).toContain(`omits a denied canary for evaluator path ${extra}`);
  const link = join(f.root, 'protected-link'); await symlink(f.launch.controlRoot, link);
  const unsafe = await verify([link]).catch((error: Error) => error);
  expect(String((unsafe as Error).cause)).toContain('Unsupported protected native path');
  await expect(access(preflight(f.launch.controlRoot))).rejects.toThrow();
});
