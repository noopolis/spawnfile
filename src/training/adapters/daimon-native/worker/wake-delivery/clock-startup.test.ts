import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { configFixture, launchFixture, sandboxProjectionFixture } from '../../test-fixtures.js';
import { sha256, type NativeTaskClockEvidence } from '../../receipt/index.js';
import * as runtime from '../public.js';
import * as listener from '../server.js';
import { runDaimonNativeWorker } from '../worker.js';
import type { NativeConfig, NativeHost } from '../types.js';

const clock = { origin: '2001-01-01T12:30:00+02:00', libfaketimePath: '/usr/lib/faketime/libfaketime.so.1' };

test.each([true, false])('worker installs task-clock contract before host creation and emits only declared evidence (enabled=%s)', async enabled => {
  const f = await launchFixture();
  const platform = process.platform, environment = { ...process.env }, exitCode = process.exitCode;
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  // Socket behavior is covered by server tests. This startup contract check also
  // runs in sandboxes that refuse local TCP binds; the real worker still executes.
  const listen = vi.spyOn(listener, 'listenWorker').mockResolvedValue(undefined);
  const handlers: (() => void)[] = [];
  const once = vi.spyOn(process, 'once').mockImplementation(((event: string, handler: () => void) => {
    if (event === 'SIGTERM') handlers.push(handler);
    return process;
  }) as typeof process.once);
  let created: { realNow: number; clock: string | undefined; preload: string | undefined } | undefined;
  let stopped = false;
  const host = {
    start: async () => undefined,
    stop: async () => { stopped = true; return {}; },
    health: async () => ({ version: 'noopolis.daimon.organization-runtime-health.v1', state: 'running', agents: [] }),
    activityV2: async () => ({ version: 'native-unit', items: [], executions: [] }),
  } as unknown as NativeHost;
  const load = vi.spyOn(runtime, 'loadDaimonRuntime').mockResolvedValue({
    parseOrganizationRuntimeConfig: value => value as NativeConfig,
    createOrganizationRuntimeControlHost: () => {
      created = { realNow: Date.now(), clock: process.env.NOOPOLIS_TASK_CLOCK, preload: process.env.LD_PRELOAD };
      return host;
    },
    resolveOrganizationCodexSandboxProjection: async value => {
      const agent = (value as NativeConfig).agents[0]!;
      return sandboxProjectionFixture(agent.id, agent.workspacePath, agent.runtimeHomePath);
    },
  });
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.NOOPOLIS_TASK_CLOCK = 'stale clock must not reach the host';
    process.env.LD_PRELOAD = '/stale/libfaketime.so.1';
    if (enabled) f.launch.taskClock = clock;
    const config = configFixture(f.root);
    f.launch.host.port = config.host.port;
    f.launch.workspace.target = config.agents[0]!.workspacePath;
    f.launch.projections[0]!.target = config.agents[0]!.runtimeHomePath;
    f.launch.projections[1]!.target = config.agents[0]!.memory!.runtimeHomePath;
    const bytes = JSON.stringify(config);
    f.launch.configSha256 = sha256(bytes);
    await writeFile(f.launch.config, bytes);
    await f.save();
    const before = Date.now();
    await runDaimonNativeWorker(['--launch', f.launch.receiptFile, '--config', f.launch.config,
      '--config-sha256', f.launch.configSha256, '--control-root', f.launch.controlRoot,
      '--token-file', f.launch.tokenFile, '--evidence', join(f.launch.controlRoot, 'evidence'),
      '--trial-id', 'unit-clock-startup', '--timeout-ms', '5000', '--schedule-override', 'disabled']);
    expect(created).toBeDefined();
    const readyLine = stdout.mock.calls.map(([value]) => String(value)).find(value => value.includes('paideia.daimon-native.ready.v1'));
    expect(readyLine).toBeDefined();
    const ready = JSON.parse(readyLine!) as { taskClock?: NativeTaskClockEvidence };
    if (enabled) {
      expect(ready.taskClock).toEqual({ version: 'noopolis.task-clock.v1', origin: clock.origin, anchorEpochMs: expect.any(Number) });
      expect(ready.taskClock!.anchorEpochMs).toBeGreaterThanOrEqual(before);
      expect(ready.taskClock!.anchorEpochMs).toBeLessThanOrEqual(created!.realNow);
      expect(created!.clock).toBe(JSON.stringify(ready.taskClock));
      expect(created!.preload).toBe(clock.libfaketimePath);
      expect(ready.taskClock).not.toHaveProperty('libfaketimePath');
    } else {
      expect(ready).not.toHaveProperty('taskClock');
      expect(created!.clock).toBeUndefined();
      expect(created!.preload).toBeUndefined();
    }
    expect(created!.realNow).toBeGreaterThanOrEqual(before);
    expect(process.env.DAIMON_ENGINE_WAKE_TIMEOUT_MS).toBe('5000');
    expect(listen).toHaveBeenCalledWith(expect.anything(), '127.0.0.1', config.host.port);
    handlers[0]!();
    await vi.waitFor(() => expect(stdout.mock.calls.some(([value]) => String(value).includes('paideia.daimon-native.stop.v1'))).toBe(true));
    expect(stopped).toBe(true);
  } finally {
    if (handlers.length && !stopped) {
      handlers[0]!();
      await vi.waitFor(() => expect(stopped).toBe(true));
    }
    load.mockRestore(); listen.mockRestore(); once.mockRestore(); stdout.mockRestore();
    Object.defineProperty(process, 'platform', { value: platform }); process.exitCode = exitCode;
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
    await rm(f.root, { recursive: true, force: true });
  }
});
