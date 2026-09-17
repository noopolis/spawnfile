import { afterEach, expect, it, vi } from 'vitest';
import { access, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { childFixture } from './fixture.js';
import { verifyChildSandbox } from './sandbox.js';
import { createGrokSlotFreshnessStore } from './slot-freshness.js';
import { bindGrokBrokerProjection, grokProjectionSha256 } from '../receipt/index.js';
import { grokLaunchFrom, grokProjectionFor, slotPreflightFor } from '../grok-fixtures.js';
vi.mock('node:child_process', () => ({ execFile: vi.fn(() => { throw new Error('Grok slot checks never run a local sandbox command'); }) }));
const roots: string[] = [];
afterEach(async () => { vi.clearAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/** Mirrors the intended flow: request freshness, write it into launch.v2, the supervisor echoes it in its receipt. */
async function fixture(generation?: number, nonce?: string) {
  const f = await childFixture(); roots.push(f.root);
  const launch = await grokLaunchFrom(f.launch, f.root);
  const slots = createGrokSlotFreshnessStore(join(f.root, 'slot-freshness.json'));
  const freshness = await slots.request(launch.broker.slot);
  Object.assign(launch.broker, freshness);
  const projection = grokProjectionFor(launch, f.input.protectedPaths);
  launch.broker.projectionSha256 = grokProjectionSha256(projection); await f.save();
  const write = (value = slotPreflightFor(projection, projection.denyPaths, generation ?? freshness.minGeneration, nonce ?? freshness.expectedNonce)) =>
    writeFile(join(launch.controlRoot, 'sandbox-projection.json'), JSON.stringify(bindGrokBrokerProjection(projection, value, f.input.trialId, launch.configSha256)), { mode: 0o600 });
  const verify = (paths = f.input.protectedPaths!, trial = f.input.trialId) => verifyChildSandbox(launch, trial, paths, new AbortController().signal, slots);
  return { ...f, launch, projection, slots, freshness, write, verify };
}
const preflight = (root: string) => join(root, 'child-sandbox-preflight.json');
const cause = (error: unknown) => String((error as Error).cause);

it('accepts only the fresh supervisor receipt that denies every evaluator and caller-protected path, without a local probe', async () => {
  const f = await fixture();
  expect(f.freshness.minGeneration).toBe(1);
  await f.write(); await f.verify();
  expect(execFile).not.toHaveBeenCalled();
  const receipt = JSON.parse(await readFile(preflight(f.launch.controlRoot), 'utf8'));
  expect(receipt).toMatchObject({ schema: 'paideia.daimon-native.child-grok-slot-preflight.v1', trialId: f.input.trialId, modelCallsMade: 0,
    localSandboxProbe: false, slotGeneration: 1, projectionSha256: f.launch.broker.projectionSha256 });
  expect(receipt.evaluatorPathsDenied).toEqual(expect.arrayContaining([...f.input.protectedPaths!, f.launch.controlRoot]));
  expect((await f.slots.request(f.launch.broker.slot)).minGeneration).toBe(2);
});

it('fails closed without the slot receipt or freshness store, for another trial, or when a caller-protected path lacks a denied canary', async () => {
  const f = await fixture();
  await expect(f.verify()).rejects.toThrow('Grok broker slot preflight failed before cognition');
  await f.write();
  expect(cause(await verifyChildSandbox(f.launch, f.input.trialId, f.input.protectedPaths!, new AbortController().signal).catch(error => error))).toContain('freshness store');
  await expect(f.verify(f.input.protectedPaths, 'other-trial')).rejects.toThrow('before cognition');
  const extra = join(f.root, 'extra-evaluator'); await writeFile(extra, 'sealed');
  expect(cause(await f.verify([...f.input.protectedPaths!, extra]).catch(error => error))).toContain(`omits a denied canary for evaluator path ${extra}`);
  const link = join(f.root, 'protected-link'); await symlink(f.launch.controlRoot, link);
  expect(cause(await f.verify([link]).catch(error => error))).toContain('Unsupported protected native path');
  await expect(access(preflight(f.launch.controlRoot))).rejects.toThrow();
});

it('refuses a stale nonce or a replayed generation at the launch and at the persisted experiment state', async () => {
  const stale = await fixture(undefined, 'b'.repeat(64)); await stale.write();
  expect(cause(await stale.verify().catch(error => error))).toContain('stale: nonce');
  const old = await fixture(); old.launch.broker.minGeneration = 2; await old.write(slotPreflightFor(old.projection, old.projection.denyPaths, 1, old.freshness.expectedNonce));
  expect(cause(await old.verify().catch(error => error))).toContain('stale: generation');
  const replay = await fixture(); await replay.write(); await replay.verify();
  await rm(preflight(replay.launch.controlRoot));
  expect(cause(await replay.verify().catch(error => error))).toContain('stale: nonce');
  const next = await replay.slots.request(replay.launch.broker.slot);
  replay.launch.broker.expectedNonce = next.expectedNonce;
  await replay.write(slotPreflightFor(replay.projection, replay.projection.denyPaths, 1, next.expectedNonce));
  expect(cause(await replay.verify().catch(error => error))).toContain('stale: generation');
});
