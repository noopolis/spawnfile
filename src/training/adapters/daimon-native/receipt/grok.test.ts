import { expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { bindGrokBrokerProjection, canonicalJson, grokProjectionSha256, parseGrokBrokerReceipt, requiredGrokEvaluatorPaths } from './grok.js';
import { launchFixture } from '../test-fixtures.js';
import { daimonProjectionGolden, daimonProjectionGoldenSha256, grokLaunchFrom, grokProjectionFor, slotPreflightFor } from '../grok-fixtures.js';

test('canonical projection digest equals the digest Daimon binds into slot receipts', () => {
  expect(grokProjectionSha256(daimonProjectionGolden)).toBe(daimonProjectionGoldenSha256);
  expect(canonicalJson({ b: [1, 'x', null, true], a: { d: 2, c: 1 } })).toBe('{"a":{"c":1,"d":2},"b":[1,"x",null,true]}');
  for (const invalid of [Number.NaN, -0, new Date(0), undefined]) expect(() => canonicalJson(invalid)).toThrow();
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
      [rebind({ ...projection, model: 'grok-4.5' }), /model/],
      [rebind({ ...projection, reasoningEffort: 'high' }), /model/],
      [rebind({ ...projection, slot: 3 }), /slot/],
      [rebind({ ...projection, limits: { ...projection.limits, maxTokens: 1 } }), /slot/],
      [{ ...bound, projectionSha256: 'f'.repeat(64) }, /projection_sha256/],
      [rebind({ ...projection, profileSha256: 'e'.repeat(64) }), /projection_sha256/],
      [{ ...bound, slotPreflight: { ...bound.slotPreflight, projection_sha256: 'f'.repeat(64) } }, /projection_sha256/],
      [{ ...bound, slotPreflight: { ...bound.slotPreflight, worker_uid: 2201 } }, /slot_preflight/],
      [{ ...bound, slotPreflight: { ...bound.slotPreflight, sandbox_profile_sha256: 'e'.repeat(64) } }, /slot_preflight/],
      [{ ...bound, slotPreflight: { ...bound.slotPreflight, canaries: bound.slotPreflight.canaries.slice(1) } }, /canaries/],
      [{ ...bound, slotPreflight: { ...bound.slotPreflight, canaries: bound.slotPreflight.canaries.map((row, index) => index ? row : { ...row, result: 'readable' }) } }, /invalid|Invalid/],
    ];
    for (const [value, message, trial] of cases) expect(() => parseGrokBrokerReceipt(value, launch, trial ?? 'trial')).toThrow(message);
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
