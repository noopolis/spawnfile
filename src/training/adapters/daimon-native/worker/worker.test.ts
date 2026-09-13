import { expect, test, vi } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configFixture, launchFixture, sandboxProjectionFixture } from '../test-fixtures.js';
import { sha256 } from '../receipt/index.js';
import * as runtime from './public.js';
import { runDaimonNativeWorker } from './worker.js';
import type { NativeHost, NativeConfig } from './types.js';

test('worker checks real receipt bytes before boot and serves native authenticated health with an explicit unit host', async () => {
  const f = await launchFixture(); const platform = process.platform; const environment = { ...process.env }; const exitCode = process.exitCode;
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const signalHandlers: (() => void)[] = [];
  const once = vi.spyOn(process, 'once').mockImplementation(((event: string, handler: () => void) => {
    if (event === 'SIGTERM' || event === 'SIGINT') signalHandlers.push(handler);
    return process;
  }) as typeof process.once);
  let failure = ''; let stops = 0;
  const host = { start: async () => { if (failure === 'start') throw new Error('Unit start refusal'); },
    stop: async () => { stops++; return {}; },
    health: async () => ({ version: 'noopolis.daimon.organization-runtime-health.v1', state: failure === 'health' ? 'starting' : 'running', agents: [] }),
    activityV2: async () => failure === 'activity' ? undefined : ({ version: 'native-unit', items: [], executions: [] }) } as unknown as NativeHost;
  const load = vi.spyOn(runtime, 'loadDaimonRuntime').mockResolvedValue({ parseOrganizationRuntimeConfig: value => value as NativeConfig, createOrganizationRuntimeControlHost: () => host,
    resolveOrganizationCodexSandboxProjection: async value => { const agent = (value as NativeConfig).agents[0]!;
      return sandboxProjectionFixture(agent.id, agent.workspacePath, agent.runtimeHomePath); } });
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    await expect(runDaimonNativeWorker([])).rejects.toThrow('Linux');
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const config = configFixture(f.root);
    config.host.port = 19783;
    f.launch.host.port = config.host.port; f.launch.workspace.target = config.agents[0]!.workspacePath;
    f.launch.projections[0]!.target = config.agents[0]!.runtimeHomePath; f.launch.projections[1]!.target = config.agents[0]!.memory!.runtimeHomePath;
    const bytes = JSON.stringify(config); f.launch.configSha256 = sha256(bytes);
    await writeFile(f.launch.config, bytes); await f.save();
    const args = ['--launch', f.launch.receiptFile, '--config', f.launch.config, '--config-sha256', f.launch.configSha256,
      '--control-root', f.launch.controlRoot, '--token-file', f.launch.tokenFile, '--evidence', join(f.launch.controlRoot, 'evidence'),
      '--trial-id', 'unit-worker', '--timeout-ms', '1000', '--schedule-override', 'disabled'];
    await expect(runDaimonNativeWorker(args.map(value => value === f.launch.configSha256 ? 'f'.repeat(64) : value))).rejects.toThrow('digest');
    await writeFile(join(f.launch.controlRoot, 'stale'), 'stale'); await expect(runDaimonNativeWorker(args)).rejects.toThrow('empty'); await rm(join(f.launch.controlRoot, 'stale'));
    const token = await readFile(f.launch.tokenFile, 'utf8');
    for (const bad of ['short', 'a'.repeat(24) + '\ninside']) { await writeFile(f.launch.tokenFile, bad); await expect(runDaimonNativeWorker(args)).rejects.toThrow('token'); }
    await writeFile(f.launch.tokenFile, token);
    for (const reason of ['start', 'health', 'activity']) { failure = reason; await expect(runDaimonNativeWorker(args)).rejects.toThrow(); }
    failure = ''; await runDaimonNativeWorker(args);
    expect((await fetch('http://127.0.0.1:19783/trial/health', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect(stdout.mock.calls.some(([value]) => String(value).includes('paideia.daimon-native.ready.v1'))).toBe(true);
    signalHandlers[0]!(); signalHandlers[0]!();
    await vi.waitFor(async () => { await expect(fetch('http://127.0.0.1:19783/trial/health')).rejects.toThrow(); });
    expect(stops).toBeGreaterThanOrEqual(4);
    expect(process.env['DAIMON_WAKE_FUSE_MAX_TOKENS']).toBe(String(f.launch.limits.maxTokens));
  } finally {
    load.mockRestore(); once.mockRestore(); stdout.mockRestore(); Object.defineProperty(process, 'platform', { value: platform }); process.exitCode = exitCode;
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]; Object.assign(process.env, environment);
    await rm(f.root, { recursive: true, force: true });
  }
});
