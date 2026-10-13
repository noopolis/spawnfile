import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { configFixture, launchFixture } from '../test-fixtures.js';
import { grokConfigFor, grokLaunchFrom, grokProjectionFor, writeGrokSlotReceipt } from '../grok-fixtures.js';
import { grokProjectionSha256, nativeTrialArtifactsRoot, sha256 } from '../receipt/index.js';
import * as runtime from './public.js';
import { runDaimonNativeWorker } from './worker.js';
import type { NativeConfig } from './types.js';

test.each([0, 1, 2, 3])('worker binds verified slot %i before creating the native host', async slot => {
  const f = await launchFixture();
  const platform = process.platform, environment = { ...process.env };
  const launch = await grokLaunchFrom(f.launch, f.root);
  const created = new Error('verified host creation boundary');
  const seen: (string | undefined)[] = [];
  const load = vi.spyOn(runtime, 'loadDaimonRuntime').mockResolvedValue({
    parseOrganizationRuntimeConfig: value => value as NativeConfig,
    createOrganizationRuntimeControlHost: () => { seen.push(process.env.DAIMON_ENGINE_BROKER_SLOT); throw created; },
    resolveOrganizationCodexSandboxProjection: async () => { throw Error('unexpected Codex projection'); },
  });
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const config = grokConfigFor(configFixture(f.root));
    config.agents[0]!.runtimeHomePath = launch.projections[0]!.source;
    launch.host.port = config.host.port;
    launch.workspace.target = config.agents[0]!.workspacePath;
    launch.projections[0]!.target = config.agents[0]!.runtimeHomePath;
    launch.broker.slot = slot;
    launch.broker.workerUid = 2200 + slot;
    const bytes = JSON.stringify(config);
    launch.configSha256 = sha256(bytes);
    launch.broker.projectionSha256 = grokProjectionSha256(grokProjectionFor(launch));
    await writeFile(launch.config, bytes); await f.save(); await writeGrokSlotReceipt(launch);
    const artifacts = nativeTrialArtifactsRoot(launch, 'slot-startup');
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    const args = ['--launch', launch.receiptFile, '--config', launch.config, '--config-sha256', launch.configSha256,
      '--control-root', launch.controlRoot, '--token-file', launch.tokenFile, '--evidence', join(artifacts, 'evidence'),
      '--trial-id', 'slot-startup', '--timeout-ms', '900000', '--schedule-override', 'disabled'];
    // Both the normal unset environment and a stale inherited selector must bind to the receipt.
    delete process.env.DAIMON_ENGINE_BROKER_SLOT;
    await expect(runDaimonNativeWorker(args)).rejects.toBe(created);
    process.env.DAIMON_ENGINE_BROKER_SLOT = String((slot + 1) % 4);
    await expect(runDaimonNativeWorker(args)).rejects.toBe(created);
    expect(seen).toEqual([String(slot), String(slot)]);
  } finally {
    load.mockRestore(); Object.defineProperty(process, 'platform', { value: platform });
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
    await rm(f.root, { recursive: true, force: true });
  }
});
