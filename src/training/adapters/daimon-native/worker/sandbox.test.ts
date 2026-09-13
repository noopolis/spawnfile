import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { persistNativeSandboxProjection } from './sandbox.js';
import { configFixture, launchFixture, sandboxProjectionFixture } from '../test-fixtures.js';
import type { NativeRuntimeModule } from './public.js';
import type { WorkerOptions } from './types.js';

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
