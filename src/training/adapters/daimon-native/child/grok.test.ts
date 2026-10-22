import { afterEach, expect, it, vi } from 'vitest';
import { access, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { childFixture } from './fixture.js';
import { verifyChildSandbox } from './sandbox.js';
import { createGrokSlotFreshnessStore } from './slot-freshness.js';
import { bindGrokBrokerProjection, grokProjectionSha256, nativeTrialArtifactsRoot } from '../receipt/index.js';
import { grokLaunchFrom, grokProjectionFor, grokProtectedPaths, slotPreflightFor } from '../grok-fixtures.js';
vi.mock('node:child_process', () => ({ execFile: vi.fn(() => { throw new Error('Grok slot checks never run a local sandbox command'); }) }));
const roots: string[] = [];
afterEach(async () => { vi.clearAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/** Mirrors the intended flow: request freshness, write it into launch.v2, the supervisor echoes it in its receipt. */
async function fixture(generation?: number, nonce?: string) {
  const f = await childFixture(); roots.push(f.root);
  const launch = await grokLaunchFrom(f.launch, f.root);
  // Grok protects evaluator roots the slot receipt denies, never the subject's own workspace or runtime home.
  // The engine-neutral trial runner also protects the workspace and runtime home it allocated.
  f.input.protectedPaths = [...grokProtectedPaths(f.root), f.launch.workspace.source, launch.projections[0]!.source];
  const slots = createGrokSlotFreshnessStore(join(f.root, 'slot-freshness.json'));
  const freshness = await slots.request(launch.broker.slot);
  Object.assign(launch.broker, freshness);
  const projection = grokProjectionFor(launch, grokProtectedPaths(f.root));
  launch.broker.projectionSha256 = grokProjectionSha256(projection); await f.save();
  const artifacts = async (trial = f.input.trialId): Promise<string> => {
    const root = nativeTrialArtifactsRoot(launch, trial);
    await mkdir(root, { recursive: true, mode: 0o700 });
    return root;
  };
  const write = async (value = slotPreflightFor(projection, projection.denyPaths, generation ?? freshness.minGeneration, nonce ?? freshness.expectedNonce), trial = f.input.trialId) =>
    writeFile(join(await artifacts(trial), 'sandbox-projection.json'), JSON.stringify(bindGrokBrokerProjection(projection, value, f.input.trialId, launch.configSha256)), { mode: 0o600 });
  const verify = (paths = f.input.protectedPaths!, trial = f.input.trialId) => verifyChildSandbox(launch, trial, paths, new AbortController().signal, slots);
  return { ...f, launch, projection, slots, freshness, artifacts, write, verify };
}
const preflight = (root: string) => join(root, 'child-sandbox-preflight.json');
const cause = (error: unknown) => String((error as Error).cause);

it('accepts only the fresh supervisor receipt that denies every evaluator and caller-protected path, without a local probe', async () => {
  const f = await fixture();
  expect(f.freshness.minGeneration).toBe(1);
  await f.write(); await f.verify();
  expect(execFile).not.toHaveBeenCalled();
  const receipt = JSON.parse(await readFile(preflight(await f.artifacts()), 'utf8'));
  expect(receipt).toMatchObject({ schema: 'paideia.daimon-native.child-grok-slot-preflight.v1', trialId: f.input.trialId, modelCallsMade: 0,
    localSandboxProbe: false, slotGeneration: 1, projectionSha256: f.launch.broker.projectionSha256 });
  // The two digest-bound subject roots are exempt; every other protected path is still required denied.
  expect(receipt.evaluatorPathsDenied).toEqual(expect.arrayContaining([...grokProtectedPaths(f.root), f.launch.controlRoot]));
  expect(receipt.evaluatorPathsDenied).not.toContain(f.launch.projections[0]!.source);
  expect(receipt.evaluatorPathsDenied).not.toContain(f.launch.workspace.source);
  expect((await f.slots.request(f.launch.broker.slot)).minGeneration).toBe(2);
});

it('fails closed without the slot receipt or freshness store, for another trial, or when a caller-protected path lacks a denied canary', async () => {
  const f = await fixture();
  await expect(f.verify()).rejects.toThrow('Grok broker slot preflight failed before cognition');
  await f.write();
  expect(cause(await verifyChildSandbox(f.launch, f.input.trialId, f.input.protectedPaths!, new AbortController().signal).catch(error => error))).toContain('freshness store');
  await f.write(undefined, 'other-trial');
  expect(cause(await f.verify(f.input.protectedPaths, 'other-trial').catch(error => error))).toContain('not bound to this trial');
  const extra = join(f.root, 'extra-evaluator'); await writeFile(extra, 'sealed');
  expect(cause(await f.verify([...f.input.protectedPaths!, extra]).catch(error => error))).toContain(`omits a denied canary for evaluator path ${extra}`);
  // Only the subject roots themselves are exempt; a protected path inside one has no denied canary and never gets one.
  const inside = join(f.launch.projections[0]!.source, 'evaluator-secret'); await writeFile(inside, 'sealed');
  expect(cause(await f.verify([...f.input.protectedPaths!, inside]).catch(error => error))).toContain(`omits a denied canary for evaluator path ${inside}`);
  const link = join(f.root, 'protected-link'); await symlink(f.launch.controlRoot, link);
  expect(cause(await f.verify([link]).catch(error => error))).toContain('Unsupported protected native path');
  await expect(access(preflight(await f.artifacts()))).rejects.toThrow();
});

it('keeps an unresolvable subject root exempt and still fails closed on an absent protected path', async () => {
  // A subject root the slot has not materialized cannot be resolved, so exemption falls back to the
  // declared path. The receipt still binds, and nothing silently drops out of the required set.
  const exempt = await fixture(); await exempt.write();
  await rm(exempt.launch.projections[0]!.source, { recursive: true, force: true });
  await exempt.verify();
  expect(JSON.parse(await readFile(preflight(await exempt.artifacts()), 'utf8')).evaluatorPathsDenied)
    .not.toContain(exempt.launch.projections[0]!.source);
  const missing = await fixture(); await missing.write();
  const absent = join(missing.root, 'absent-evaluator');
  expect(cause(await missing.verify([...missing.input.protectedPaths!, absent]).catch(error => error))).toContain(absent);
  await expect(access(preflight(await missing.artifacts()))).rejects.toThrow();
});

it('refuses a stale nonce or a replayed generation at the launch and at the persisted experiment state', async () => {
  const stale = await fixture(undefined, 'b'.repeat(64)); await stale.write();
  expect(cause(await stale.verify().catch(error => error))).toContain('stale: nonce');
  const old = await fixture(); old.launch.broker.minGeneration = 2; await old.write(slotPreflightFor(old.projection, old.projection.denyPaths, 1, old.freshness.expectedNonce));
  expect(cause(await old.verify().catch(error => error))).toContain('stale: generation');
  const replay = await fixture(); await replay.write(); await replay.verify();
  await rm(preflight(await replay.artifacts()));
  expect(cause(await replay.verify().catch(error => error))).toContain('stale: nonce');
  const next = await replay.slots.request(replay.launch.broker.slot);
  replay.launch.broker.expectedNonce = next.expectedNonce;
  await replay.write(slotPreflightFor(replay.projection, replay.projection.denyPaths, 1, next.expectedNonce));
  expect(cause(await replay.verify().catch(error => error))).toContain('stale: generation');
});
