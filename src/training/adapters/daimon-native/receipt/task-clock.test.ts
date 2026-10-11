import { rm } from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { launchFixture } from '../test-fixtures.js';
import { grokLaunchFrom } from '../grok-fixtures.js';
import { parseNativeLaunch } from './schema.js';
import { configureNativeTaskClock, nativeTaskClockSchema } from './task-clock.js';

const clock = { origin: '2024-02-29T12:00:00+02:00', anchorEpochMs: 1_800_000_000_123,
  libfaketimePath: '/usr/lib/faketime/libfaketime.so.1' };
const timeoutMs = 5000;
afterEach(() => vi.unstubAllEnvs());

test('existing receipts preserve their exact shape while direct/transport and a task clock are opt-in for both engines', async () => {
  const f = await launchFixture();
  try {
    const { receiptFile: _, ...codex } = f.launch;
    const { receiptFile: __, ...grok } = await grokLaunchFrom(f.launch, f.root);
    for (const launch of [codex, { ...codex, schema: 'paideia.daimon-native.launch.v2' }, grok]) {
      expect(parseNativeLaunch(launch)).toEqual(launch);
      expect(parseNativeLaunch(launch)).not.toHaveProperty('delivery');
      expect(parseNativeLaunch(launch)).not.toHaveProperty('taskClock');
      for (const delivery of ['direct', 'transport']) {
        const declared = { ...launch, delivery, taskClock: clock,
          ...('broker' in launch ? { broker: { ...launch.broker, workerConfigVariant: 'clocked' } } : {}) };
        expect(parseNativeLaunch(declared)).toEqual(declared);
      }
      for (const invalid of [{ ...launch, delivery: 'manual' }, { ...launch, delivery: null },
        { ...launch, taskClock: { ...clock, origin: 'invalid' } },
        { ...launch, taskClock: { ...clock, libfaketimePath: '/tmp/unrelated.so' } }]) {
        expect(() => parseNativeLaunch(invalid)).toThrow();
      }
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('task clock accepts explicit offsets, leap dates and inclusive UTC bounds', () => {
  for (const origin of ['1970-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z',
    '2000-02-29T12:34:56.123Z', '2100-02-28T00:00:00Z', '2026-10-11T00:00:00+0200',
    '1969-12-31T23:00:00-01:00', clock.origin]) {
    expect(nativeTaskClockSchema.parse({ ...clock, origin }).origin).toBe(origin);
  }
  for (const libfaketimePath of ['libfaketimeMT.so.1', '/usr/local/lib/libfaketime.so']) {
    expect(nativeTaskClockSchema.parse({ ...clock, libfaketimePath }).libfaketimePath).toBe(libfaketimePath);
  }
});

test('invalid origins fail closed before changing environment', () => {
  for (const origin of ['invalid', '', '2024-02-29', '2024-02-29T12:00:00', '2024-02-29T24:00:00Z',
    '2024-02-29T12:00:60Z', '2023-02-29T12:00:00Z', '2100-02-29T00:00:00Z', '2024-02-30T12:00:00Z',
    '2024-04-31T12:00:00Z', '2024-00-01T00:00:00Z', '2024-13-01T00:00:00Z', '2024-01-00T00:00:00Z',
    '2024-01-32T00:00:00Z', '1969-12-31T23:59:59.999Z', '1970-01-01T00:00:00+00:01',
    '9999-12-31T23:59:59-00:01', '10000-01-01T00:00:00Z', '2024-02-29T12:00:00+24:00']) {
    const env = { UNRELATED: 'retained' };
    expect(() => configureNativeTaskClock({ ...clock, origin }, timeoutMs, env, () => clock.anchorEpochMs)).toThrow('task clock ISO instant');
    expect(env).toEqual({ UNRELATED: 'retained' });
  }
});

test('invalid preload names, loader lists and unknown clock fields fail closed', () => {
  for (const libfaketimePath of ['', '/tmp/other.so', '/tmp/libfaketime.dylib', '/tmp/libfaketime.so/other.so',
    '/tmp/libfaketime.so.1:/tmp/other.so', 'libfaketime.so.1 libother.so', 'libfaketime.so.1:libfaketimeMT.so.1',
    '/tmp/libfaketime.so.1\0ignored', '/tmp/libfaketime.so.1\n']) {
    const env = {};
    expect(() => configureNativeTaskClock({ ...clock, libfaketimePath }, timeoutMs, env, () => clock.anchorEpochMs)).toThrow('libfaketime');
    expect(env).toEqual({});
  }
  for (const value of [null, [], {}, { origin: clock.origin },
    { ...clock, version: 'noopolis.task-clock.v1' }]) expect(() => nativeTaskClockSchema.parse(value)).toThrow();
});

test('task clock requires a caller-supplied safe-integer anchor', async () => {
  const f = await launchFixture();
  try {
    const { receiptFile: _, ...launch } = f.launch;
    const { anchorEpochMs: __, ...missing } = clock;
    expect(() => parseNativeLaunch({ ...launch, taskClock: missing })).toThrow('anchorEpochMs');
    for (const anchorEpochMs of [undefined, null, '1800000000123', NaN, Infinity, -Infinity, 1.5,
      Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1]) {
      expect(() => parseNativeLaunch({ ...launch, taskClock: { ...clock, anchorEpochMs } })).toThrow('anchorEpochMs');
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('clock environment retains the exact caller anchor instead of minting one at startup', () => {
  const env: NodeJS.ProcessEnv = { PATH: '/bin', LD_PRELOAD: '/stale.so', NOOPOLIS_TASK_CLOCK: 'stale' };
  const { anchorEpochMs } = clock;
  const evidence = configureNativeTaskClock(clock, timeoutMs, env, () => anchorEpochMs + 1234);
  expect(evidence).toEqual({ version: 'noopolis.task-clock.v1', origin: clock.origin, anchorEpochMs });
  expect(env).toEqual({ PATH: '/bin', LD_PRELOAD: clock.libfaketimePath,
    NOOPOLIS_TASK_CLOCK: '{"version":"noopolis.task-clock.v1","origin":"2024-02-29T12:00:00+02:00","anchorEpochMs":1800000000123}' });
});

test('anchor freshness admits inclusive deadline and one-second future boundaries', () => {
  for (const elapsedMs of [-1000, 0, timeoutMs]) {
    const evidence = configureNativeTaskClock(clock, timeoutMs, {}, () => clock.anchorEpochMs + elapsedMs);
    expect(evidence!.anchorEpochMs).toBe(clock.anchorEpochMs);
  }
});

test('future or expired anchors are refused before environment mutation', () => {
  for (const [elapsedMs, reason] of [[-1001, 'more than 1000 ms in the future'],
    [timeoutMs + 1, 'older than the trial deadline window']] as const) {
    const env = { NOOPOLIS_TASK_CLOCK: 'original', LD_PRELOAD: '/original.so' };
    expect(() => configureNativeTaskClock(clock, timeoutMs, env, () => clock.anchorEpochMs + elapsedMs)).toThrow(reason);
    expect(env).toEqual({ NOOPOLIS_TASK_CLOCK: 'original', LD_PRELOAD: '/original.so' });
  }
});

test('invalid real clocks and trial windows cannot bypass anchor freshness validation', () => {
  for (const invalid of [NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const unchanged = {};
    expect(() => configureNativeTaskClock(clock, timeoutMs, unchanged, () => invalid)).toThrow('safe integer real timestamp');
    expect(unchanged).toEqual({});
  }
  for (const invalid of [NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, 0, -1]) {
    const unchanged = {};
    expect(() => configureNativeTaskClock(clock, invalid, unchanged, () => clock.anchorEpochMs)).toThrow('positive safe integer trial timeout');
    expect(unchanged).toEqual({});
  }
});

test('absent clock unsets contract values without sampling an anchor', () => {
  const env: NodeJS.ProcessEnv = { PATH: '/bin', LD_PRELOAD: clock.libfaketimePath, NOOPOLIS_TASK_CLOCK: 'stale' };
  const now = vi.fn(() => 42);
  expect(configureNativeTaskClock(undefined, timeoutMs, env, now)).toBeUndefined();
  expect(env).toEqual({ PATH: '/bin' });
  expect(now).not.toHaveBeenCalled();
});

test('default environment configuration retains a supplied anchor without shifting this worker', () => {
  vi.stubEnv('NOOPOLIS_TASK_CLOCK', undefined);
  vi.stubEnv('LD_PRELOAD', undefined);
  const before = Date.now();
  const declared = { ...clock, anchorEpochMs: before - 2000 };
  const evidence = configureNativeTaskClock(declared, timeoutMs)!;
  const after = Date.now();
  expect(evidence.anchorEpochMs).toBe(declared.anchorEpochMs);
  expect(after - before).toBeLessThan(1000);
  expect(JSON.parse(process.env.NOOPOLIS_TASK_CLOCK!)).toEqual(evidence);
  expect(process.env.LD_PRELOAD).toBe(clock.libfaketimePath);
  configureNativeTaskClock(undefined, timeoutMs);
  expect(process.env.NOOPOLIS_TASK_CLOCK).toBeUndefined();
  expect(process.env.LD_PRELOAD).toBeUndefined();
});
