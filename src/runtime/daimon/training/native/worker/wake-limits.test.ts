import { expect, test, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configFixture, launchFixture, sandboxProjectionFixture } from '../test-fixtures.js';
import { grokConfigFor, grokLaunchFrom, grokProjectionFor, writeGrokSlotReceipt } from '../grok-fixtures.js';
import { grokProjectionSha256, isGrokLaunch, nativeTrialArtifactsRoot, sha256, type GrokBrokerProjection } from '../receipt/index.js';
import * as runtime from './public.js';
import * as server from './server.js';
import { runDaimonNativeWorker } from './worker.js';
import type { NativeConfig, NativeHost } from './types.js';

test.each([
  { engine: 'grok', deadline: 3600000, expected: 1800000, tokenCeiling: 1000000 },
  { engine: 'grok', deadline: 900000, expected: 900000, tokenCeiling: 400000 },
  { engine: 'grok', deadline: 1800000, expected: 1800000, tokenCeiling: 1000000 },
  { engine: 'codex', deadline: 3600000, expected: 3600000, tokenCeiling: 1000000 },
  { engine: 'codex', deadline: 1000, expected: 1000, tokenCeiling: 1000000 },
])('$engine installs a $expected ms wake override for a $deadline ms trial before creating the host', async ({ engine, deadline, expected, tokenCeiling }) => {
  const f = await launchFixture();
  const platform = process.platform;
  const environment = { ...process.env };
  const handlers: (() => void)[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process, 'once').mockImplementation(((event: string, handler: () => void) => {
    if (event === 'SIGTERM') handlers.push(handler);
    return process;
  }) as typeof process.once);
  // Limits are installed during real startup; HTTP behavior is covered by worker/server tests.
  vi.spyOn(server, 'listenWorker').mockResolvedValue(undefined);
  const start = vi.fn(async () => undefined);
  const stop = vi.fn(async () => ({}));
  let state = 'running';
  const host = { start, stop, health: async () => ({ state, agents: [] }),
    activityV2: async () => ({ items: [], executions: [] }) } as unknown as NativeHost;
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const launch = engine === 'grok' ? await grokLaunchFrom(f.launch, f.root) : f.launch;
    const config = engine === 'grok' ? grokConfigFor(configFixture(f.root)) : configFixture(f.root);
    const agent = config.agents[0]!;
    launch.workspace.target = agent.workspacePath;
    if (isGrokLaunch(launch)) agent.runtimeHomePath = launch.projections[0]!.source;
    launch.projections[0]!.target = agent.runtimeHomePath;
    if (!isGrokLaunch(launch)) launch.projections[1]!.target = agent.memory!.runtimeHomePath;
    launch.limits.wakeTokenCeiling = tokenCeiling;
    const bytes = JSON.stringify(config);
    launch.configSha256 = sha256(bytes);
    if (isGrokLaunch(launch)) {
      launch.broker.limits.timeoutMs = 1800000;
      launch.broker.projectionSha256 = grokProjectionSha256(grokProjectionFor(launch));
      await writeGrokSlotReceipt(launch);
    }
    await writeFile(launch.config, bytes);
    await f.save();
    const artifacts = nativeTrialArtifactsRoot(launch, 'limits');
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    const createHost = vi.fn(() => {
      expect(process.env.DAIMON_ENGINE_WAKE_TIMEOUT_MS).toBe(String(expected));
      expect(process.env.DAIMON_CODEX_WAKE_TIMEOUT_MS).toBe(String(expected));
      expect(process.env.DAIMON_ENGINE_WAKE_TOKEN_CEILING).toBe(engine === 'grok' ? '400000' : '1000000');
      expect(process.env.DAIMON_CODEX_WAKE_TOKEN_CEILING).toBe(process.env.DAIMON_ENGINE_WAKE_TOKEN_CEILING);
      expect(process.env.DAIMON_WAKE_FUSE_MAX_TOKENS).toBe(String(launch.limits.maxTokens));
      return host;
    });
    vi.spyOn(runtime, 'loadDaimonRuntime').mockResolvedValue({
      parseOrganizationRuntimeConfig: value => value as NativeConfig, createOrganizationRuntimeControlHost: createHost,
      resolveOrganizationCodexSandboxProjection: async () => sandboxProjectionFixture(agent.id, agent.workspacePath, agent.runtimeHomePath),
      resolveOrganizationGrokBrokerProjection: () => grokProjectionFor(launch as Parameters<typeof grokProjectionFor>[0]),
      grokBrokerProjectionSha256: value => grokProjectionSha256(value as GrokBrokerProjection), verifyGrokSlotPreflightReceipt: value => value,
    });
    const args = ['--launch', launch.receiptFile, '--config', launch.config, '--config-sha256', launch.configSha256,
      '--control-root', launch.controlRoot, '--token-file', launch.tokenFile, '--evidence', join(artifacts, 'evidence.json'),
      '--trial-id', 'limits', '--timeout-ms', String(deadline), '--schedule-override', 'disabled'];
    if (engine === 'codex' && deadline === 3600000) {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      await expect(runDaimonNativeWorker(args)).rejects.toThrow('Linux');
      Object.defineProperty(process, 'platform', { value: 'linux' });
      await writeFile(join(artifacts, 'stale'), 'stale');
      await expect(runDaimonNativeWorker(args)).rejects.toThrow('empty');
      await rm(join(artifacts, 'stale'));
      const token = await readFile(launch.tokenFile, 'utf8');
      for (const invalid of ['short', 'long-token-with-a-forbidden space']) {
        await writeFile(launch.tokenFile, invalid);
        await expect(runDaimonNativeWorker(args)).rejects.toThrow('token');
      }
      await writeFile(launch.tokenFile, token);
      state = 'starting';
      await expect(runDaimonNativeWorker(args)).rejects.toThrow('fresh idle runtime');
      expect(stop).toHaveBeenCalledOnce();
      state = 'running'; start.mockClear(); stop.mockClear(); createHost.mockClear();
    }
    await runDaimonNativeWorker(args);
    expect(createHost).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(stdout.mock.calls.some(([value]) => String(value).includes('paideia.daimon-native.ready.v1'))).toBe(true);
    const projection = JSON.parse(await readFile(join(artifacts, 'sandbox-projection.json'), 'utf8')) as Record<string, unknown>;
    expect(projection.trialId).toBe('limits');
    handlers[0]!();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(stdout.mock.calls.some(([value]) => String(value).includes('paideia.daimon-native.stop.v1'))).toBe(true));
  } finally {
    handlers[0]?.();
    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', { value: platform });
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
    await rm(f.root, { recursive: true, force: true });
  }
});
