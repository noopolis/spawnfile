import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { persistNativeSandboxProjection } from './sandbox.js';
import { configFixture, launchFixture, sandboxProjectionFixture } from '../test-fixtures.js';
import type { NativeRuntimeModule } from './public.js';
import type { WorkerOptions } from './types.js';
import { grokConfigFor, grokLaunchFrom, grokProjectionFor, slotPreflightFor, writeGrokSlotReceipt } from '../grok-fixtures.js';
import { grokProjectionSha256, nativeTrialArtifactsRoot } from '../receipt/index.js';

test('worker resolves exact control-host inputs and refuses another native agent projection', async () => {
  const f = await launchFixture();
  const config = configFixture();
  const agent = config.agents[0]!;
  const options = { trialId: f.input.trialId, configSha256: f.launch.configSha256, controlRoot: f.launch.controlRoot } as WorkerOptions;
  let wrong = true;
  const runtime = { resolveOrganizationCodexSandboxProjection: async (value, agentId, context) => {
    assert.equal(value, config); assert.equal(agentId, agent.id); assert.equal(context.acceptanceStorePath, f.launch.controlRoot);
    return sandboxProjectionFixture(wrong ? 'foreign' : agent.id, agent.workspacePath, agent.runtimeHomePath);
  } } as NativeRuntimeModule;
  try {
    await assert.rejects(persistNativeSandboxProjection(runtime, config, options), /not bound/);
    await assert.rejects(readFile(join(f.launch.controlRoot, 'sandbox-projection.json')), /ENOENT/);
    wrong = false;
    await persistNativeSandboxProjection(runtime, config, options);
    const receipt = JSON.parse(await readFile(join(f.launch.controlRoot, 'sandbox-projection.json'), 'utf8'));
    assert.equal(receipt.trialId, f.input.trialId); assert.equal(receipt.configSha256, f.launch.configSha256);
    assert.equal(receipt.projection.agentId, agent.id);
    await assert.rejects(persistNativeSandboxProjection(runtime, config, options), /EEXIST/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('Grok slot projection is resolved by Daimon, digest-bound to the launch and requires a verified supervisor receipt', async () => {
  const f = await launchFixture();
  try {
    const launch = await grokLaunchFrom(f.launch, f.root);
    const config = grokConfigFor(configFixture());
    config.agents[0]!.workspacePath = launch.workspace.target; config.agents[0]!.runtimeHomePath = '/native/home';
    const options = { trialId: 'grok-trial', configSha256: launch.configSha256, controlRoot: launch.controlRoot, timeoutMs: 900_000 } as WorkerOptions;
    // The slot control root is shared between trials, so Paideia's artifacts live in this trial's own directory inside it.
    const artifacts = nativeTrialArtifactsRoot(launch, options.trialId);
    assert.equal(artifacts.startsWith(`${launch.controlRoot}/`), true);
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    let projection = grokProjectionFor(launch);
    let daimonDigest: ((value: unknown) => string) | undefined;
    let verifyFailure: string | undefined;
    const calls: unknown[] = [];
    const grokRuntime: Partial<NativeRuntimeModule> = {
      resolveOrganizationGrokBrokerProjection: (value, agentId, context) => { calls.push([value, agentId, context]); return projection; },
      grokBrokerProjectionSha256: value => daimonDigest ? daimonDigest(value) : grokProjectionSha256(value as typeof projection),
      verifyGrokSlotPreflightReceipt: (value, bound, freshness) => {
        if (verifyFailure) throw new Error(verifyFailure);
        assert.deepEqual(bound, projection); calls.push(freshness); return value;
      },
    };
    const runtime = grokRuntime as NativeRuntimeModule;
    const persist = () => persistNativeSandboxProjection(runtime, config, options, launch);
    await assert.rejects(persistNativeSandboxProjection({} as NativeRuntimeModule, config, options, launch), /lacks the Grok broker/);
    await assert.rejects(persist(), /root slot supervisor preflight receipt/);
    const [, agentId, context] = calls[0] as [unknown, string, { denyPaths: string[]; acceptanceStorePath: string; slot: number; limits: unknown }];
    assert.equal(agentId, 'agent:writer'); assert.equal(context.acceptanceStorePath, launch.controlRoot); assert.equal(context.slot, 0);
    // The provisioner's verbatim deny list reaches Daimon, not the evaluator-root subset.
    assert.deepEqual(context.denyPaths, [...launch.broker.denyPaths]); assert.deepEqual(context.limits, launch.broker.limits);
    await writeGrokSlotReceipt(launch);
    verifyFailure = 'Grok slot preflight receipt does not match the projection: canaries';
    await assert.rejects(persist(), /canaries/);
    verifyFailure = undefined;
    daimonDigest = () => 'f'.repeat(64);
    await assert.rejects(persist(), /disagree/);
    daimonDigest = undefined;
    projection = { ...grokProjectionFor(launch), profileSha256: 'e'.repeat(64) };
    await assert.rejects(persist(), /differs from the launch receipt/);
    const judge = launch.broker.evaluatorPaths.find(row => row.role === 'judge-home')!.path;
    projection = { ...grokProjectionFor(launch), denyPaths: grokProjectionFor(launch).denyPaths.filter(path => path !== judge) };
    launch.broker.projectionSha256 = grokProjectionSha256(projection);
    await writeGrokSlotReceipt(launch, slotPreflightFor(projection));
    await assert.rejects(persist(), /omits a denied canary for evaluator path/);
    projection = grokProjectionFor(launch); launch.broker.projectionSha256 = grokProjectionSha256(projection);
    await writeGrokSlotReceipt(launch);
    // Even behind a permissive verifier, the worker's own re-bind refuses a receipt from another recycle.
    await writeGrokSlotReceipt(launch, slotPreflightFor(projection, projection.denyPaths, launch.broker.minGeneration, 'b'.repeat(64)));
    await assert.rejects(persist(), /stale: nonce/);
    await writeGrokSlotReceipt(launch, slotPreflightFor(projection, projection.denyPaths, launch.broker.minGeneration - 1, launch.broker.expectedNonce));
    await assert.rejects(persist(), /stale: generation/);
    await writeGrokSlotReceipt(launch);
    await assert.rejects(persistNativeSandboxProjection(runtime, config, { ...options, timeoutMs: 1000 }, launch), /timeout exceeds/);
    await assert.rejects(readFile(join(artifacts, 'sandbox-projection.json')), /ENOENT/);
    await persist();
    assert.deepEqual(calls.at(-1), { expectedNonce: launch.broker.expectedNonce, minGeneration: launch.broker.minGeneration });
    const receipt = JSON.parse(await readFile(join(artifacts, 'sandbox-projection.json'), 'utf8'));
    assert.equal(receipt.schema, 'paideia.daimon-native.grok-broker-projection.v1');
    assert.equal(receipt.projectionSha256, launch.broker.projectionSha256);
    assert.equal(receipt.slotPreflight.projection_sha256, launch.broker.projectionSha256);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
