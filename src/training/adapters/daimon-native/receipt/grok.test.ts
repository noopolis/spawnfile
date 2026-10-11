import { expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { bindGrokBrokerProjection, canonicalJson, grokBrokerProjectionSchema, grokProjectionSha256, grokWorkerConfigPins,
  parseGrokBrokerReceipt, requiredGrokEvaluatorPaths } from './grok.js';
import { launchFixture } from '../test-fixtures.js';
import { daimonProjectionGolden, daimonProjectionGoldenSha256, daimonClockedProjectionGolden, daimonClockedProjectionGoldenSha256,
  grokLaunchFrom, grokProjectionFor, slotPreflightFor } from '../grok-fixtures.js';

test('canonical projection digest equals the digest Daimon binds into slot receipts', () => {
  expect(grokProjectionSha256(daimonProjectionGolden)).toBe(daimonProjectionGoldenSha256);
  expect(grokProjectionSha256(daimonClockedProjectionGolden)).toBe(daimonClockedProjectionGoldenSha256);
  expect(canonicalJson({ b: [1, 'x', null, true], a: { d: 2, c: 1 } })).toBe('{"a":{"c":1,"d":2},"b":[1,"x",null,true]}');
  const sparse = [1]; sparse.length = 2;
  const accessor = Object.defineProperty({}, 'a', { get: () => 1, enumerable: true });
  for (const invalid of [Number.NaN, -0, new Date(0), undefined, String.fromCharCode(0xd800), { [String.fromCharCode(0xdc00)]: 1 },
    String.fromCharCode(0xdc00), sparse, accessor, { [Symbol('s')]: 1 }]) expect(() => canonicalJson(invalid)).toThrow();
  const pair = String.fromCodePoint(0x1f600);
  expect(canonicalJson(Object.assign(Object.create(null) as object, { [pair]: pair, b: [[]], B: 1 }))).toBe(`{"B":1,"b":[[]],"${pair}":"${pair}"}`);
});

test('persisted Grok projection is bound to the trial, launch, digest and every evaluator canary', async () => {
  const f = await launchFixture();
  try {
    const launch = await grokLaunchFrom(f.launch, f.root);
    const projection = grokProjectionFor(launch);
    const bound = bindGrokBrokerProjection(projection, slotPreflightFor(projection), 'trial', launch.configSha256);
    expect(parseGrokBrokerReceipt(bound, launch, 'trial')).toEqual(bound);
    expect(requiredGrokEvaluatorPaths(launch)).toContain(launch.controlRoot);
    const rebind = (value: typeof projection, slot = slotPreflightFor(value)) => bindGrokBrokerProjection(value, slot, 'trial', launch.configSha256);
    const cases: [unknown, RegExp, string?][] = [
      [bound, /trial/, 'other-trial'],
      [{ ...bound, configSha256: 'f'.repeat(64) }, /trial/],
      [rebind({ ...projection, agentId: 'other' }), /agent/],
      [rebind({ ...projection, workspacePath: '/other' }), /agent/],
      [rebind({ ...projection, model: 'grok-4.5', workerConfigSha256: grokWorkerConfigPins.unclocked['grok-4.5'].low }), /model/],
      [rebind({ ...projection, reasoningEffort: 'high', workerConfigSha256: grokWorkerConfigPins.unclocked['grok-4.6'].high }), /model/],
      [rebind({ ...projection, slot: 3 }), /slot/],
      [rebind({ ...projection, limits: { ...projection.limits, maxTokens: 1 } }), /slot/],
      [{ ...bound, projectionSha256: 'f'.repeat(64) }, /projection_sha256/],
      [rebind({ ...projection, profileSha256: 'e'.repeat(64) }), /projection_sha256/],
      [{ ...bound, slotPreflight: { ...bound.slotPreflight, projection_sha256: 'f'.repeat(64) } }, /projection_sha256/],
      [{ ...bound, slotPreflight: { ...bound.slotPreflight, worker_uid: 2201 } }, /slot_preflight/],
      [{ ...bound, slotPreflight: { ...bound.slotPreflight, slot: projection.slot + 1 } }, /slot_preflight/],
      [{ ...bound, slotPreflight: { ...bound.slotPreflight, sandbox_profile_sha256: 'e'.repeat(64) } }, /slot_preflight/],
      [{ ...bound, slotPreflight: { ...bound.slotPreflight, canaries: bound.slotPreflight.canaries.slice(1) } }, /canaries/],
      [{ ...bound, slotPreflight: { ...bound.slotPreflight, canaries: bound.slotPreflight.canaries.map((row, index) => index ? row : { ...row, result: 'readable' }) } }, /invalid|Invalid/],
      [{ ...bound, slotPreflight: { ...bound.slotPreflight, canaries: [...bound.slotPreflight.canaries, bound.slotPreflight.canaries[0]] } }, /duplicate canary path/],
      [{ ...bound, slotPreflight: { ...bound.slotPreflight, worker_uid: 2199 } }, /worker_uid/],
      [{ ...bound, slotPreflight: { ...bound.slotPreflight, created_at: '2026-02-30T12:00:00.000Z' } }, /exact RFC3339/],
      [{ ...bound, slotPreflight: { ...bound.slotPreflight, version: 'noopolis.daimon.grok-slot-preflight.v1' } }, /version/],
      [{ ...bound, slotPreflight: { ...bound.slotPreflight, nonce: 'b'.repeat(64) } }, /stale: nonce/],
      [{ ...bound, slotPreflight: { ...bound.slotPreflight, generation: launch.broker.minGeneration - 1 } }, /stale: generation/],
    ];
    for (const [value, message, trial] of cases) expect(() => parseGrokBrokerReceipt(value, launch, trial ?? 'trial')).toThrow(message);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('v2 requires an explicit variant, its pinned config and exact clock metadata', () => {
  const unclocked = daimonProjectionGolden, clocked = daimonClockedProjectionGolden;
  expect(grokBrokerProjectionSchema.parse(unclocked)).toEqual(unclocked);
  expect(grokBrokerProjectionSchema.parse(clocked)).toEqual(clocked);
  for (const projection of [unclocked, clocked]) {
    for (const invalid of [
      { ...projection, version: 'noopolis.daimon.grok-broker-projection.v1' },
      { ...projection, workerConfigVariant: undefined }, { ...projection, workerConfigVariant: 'other' },
      { ...projection, workerConfigSha256: '0'.repeat(64) }, { ...projection, extra: true },
    ]) expect(() => grokBrokerProjectionSchema.parse(invalid)).toThrow();
  }
  for (const invalid of [
    { ...clocked, taskClock: undefined }, { ...unclocked, taskClock: clocked.taskClock },
    { ...clocked, workerConfigSha256: unclocked.workerConfigSha256 },
    { ...unclocked, workerConfigSha256: clocked.workerConfigSha256 },
  ]) expect(() => grokBrokerProjectionSchema.parse(invalid)).toThrow();
  for (const [key, value] of Object.entries(clocked.taskClock!)) {
    expect(() => grokBrokerProjectionSchema.parse({ ...clocked,
      taskClock: { ...clocked.taskClock, [key]: typeof value === 'number' ? value + 1 : `${value}/other` } })).toThrow();
  }
});

test('a clocked launch refuses an unclocked projection even with matching digests and canaries', async () => {
  const f = await launchFixture();
  try {
    const launch = await grokLaunchFrom(f.launch, f.root);
    const unclocked = grokProjectionFor(launch);
    const bound = bindGrokBrokerProjection(unclocked, slotPreflightFor(unclocked), 'trial', launch.configSha256);
    launch.taskClock = { origin: '2024-02-29T00:00:00Z', anchorEpochMs: Date.now(), libfaketimePath: '/usr/local/lib/daimon/libfaketime.so.1' };
    expect(() => parseGrokBrokerReceipt(bound, launch, 'trial')).toThrow('taskClock requires workerConfigVariant: clocked');
    launch.broker.workerConfigVariant = 'clocked';
    expect(() => parseGrokBrokerReceipt(bound, launch, 'trial')).toThrow('workerConfigVariant');
    const clocked = grokProjectionFor(launch);
    launch.broker.projectionSha256 = grokProjectionSha256(clocked);
    const clockedBound = bindGrokBrokerProjection(clocked, slotPreflightFor(clocked), 'trial', launch.configSha256);
    expect(parseGrokBrokerReceipt(clockedBound, launch, 'trial')).toEqual(clockedBound);
    launch.broker.workerConfigVariant = 'unclocked';
    expect(() => parseGrokBrokerReceipt(clockedBound, launch, 'trial')).toThrow('workerConfigVariant');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a slot that does not deny an evaluator root or launch control file fails closed', async () => {
  const f = await launchFixture();
  try {
    const launch = await grokLaunchFrom(f.launch, f.root);
    const judge = launch.broker.evaluatorPaths.find(row => row.role === 'judge-home')!.path;
    const withoutJudge = { ...grokProjectionFor(launch), denyPaths: grokProjectionFor(launch).denyPaths.filter(path => path !== judge) };
    launch.broker.projectionSha256 = grokProjectionSha256(withoutJudge);
    expect(() => parseGrokBrokerReceipt(bindGrokBrokerProjection(withoutJudge, slotPreflightFor(withoutJudge), 'trial', launch.configSha256), launch, 'trial'))
      .toThrow(`omits a denied canary for evaluator path ${judge}`);
    const complete = grokProjectionFor(launch);
    launch.broker.projectionSha256 = grokProjectionSha256(complete);
    const bound = bindGrokBrokerProjection(complete, slotPreflightFor(complete), 'trial', launch.configSha256);
    expect(() => parseGrokBrokerReceipt(bound, launch, 'trial', [join(f.root, 'caller-protected')])).toThrow('caller-protected');
    expect(parseGrokBrokerReceipt(bound, launch, 'trial').projectionSha256).toBe(launch.broker.projectionSha256);
    expect(() => parseGrokBrokerReceipt(bound, { ...launch, tokenFile: join(f.root, 'outside-token') }, 'trial')).toThrow('launch control file');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
