import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, grokBrokerProjectionSchema, grokProjectionSha256, grokSlotPreflightSchema } from './grok.js';
import { daimonProjectionGolden, daimonProjectionGoldenSha256, fixtureNonce, slotPreflightFor } from '../grok-fixtures.js';

/** Pins Paideia's Daimon-free mirrors to the installed Daimon contract; Daimon is an optional peer, absent in plain CI installs. */
interface DaimonGrokContract {
  resolveOrganizationGrokBrokerProjection(config: unknown, agentId: string, options: unknown): unknown;
  grokBrokerProjectionSha256(value: unknown): string;
  parseGrokSlotPreflightReceipt(value: unknown): unknown;
  verifyGrokSlotPreflightReceipt(value: unknown, projection: unknown, freshness: unknown): unknown;
}
const required = ['resolveOrganizationGrokBrokerProjection', 'grokBrokerProjectionSha256', 'parseGrokSlotPreflightReceipt', 'verifyGrokSlotPreflightReceipt'] as const;
let daimon: DaimonGrokContract | undefined;
try {
  // Same indirect specifier as the product loader: the optional peer is absent in a plain
  // `npm ci`, and a literal here would make `tsc --noEmit` fail on an uninstalled module.
  const packageName = '@noopolis/daimon/runtime';
  const loaded = await import(packageName) as Record<string, unknown>;
  if (required.every(name => typeof loaded[name] === 'function')) daimon = loaded as unknown as DaimonGrokContract;
} catch { /* reported by the visible skip reason below */ }
const contract = (): DaimonGrokContract => daimon!;

/** Daimon's own `fixtures/grok-slot-preflight/projection-input.json`, inlined so the check needs only the public export. */
const input = {
  config: { version: 'noopolis.daimon.organization-runtime.v2', host: { bindHost: '127.0.0.1', port: 19700, controlTokenEnv: 'DAIMON_CONTROL_TOKEN' },
    agents: [{ id: 'foreman', name: 'Foreman', instructions: 'Fixture agent.', workspacePath: '/var/lib/spawnfile/instance/workspace/agents/foreman',
      runtimeHomePath: '/var/lib/spawnfile/instance/homes/foreman', schedule: { kind: 'disabled' }, engine: { kind: 'grok', model: 'grok-4.6', reasoningEffort: 'low' } }] },
  options: { slot: 0, workerUid: 2200, workerHomePath: '/var/lib/daimon-workers/2200', architecture: 'arm64', usageLedgerPath: '/run/daimon-slots/0/usage/usage.jsonl',
    limits: { maxRequests: 24, maxTokens: 400000, timeoutMs: 480000 }, acceptanceStorePath: '/run/paideia/control', denyPaths: ['/run/paideia', '/run/training/inputs'],
    seccompProfileSha256: '7'.repeat(64) },
};

const accepts = (parse: () => unknown): boolean => { try { parse(); return true; } catch { return false; } };
const digest = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');

describe.skipIf(!daimon)('Daimon Grok contract parity (skipped: @noopolis/daimon/runtime with Grok projection and slot receipt v2 exports is not installed)', () => {
  it('resolves the fixture projection that Paideia mirrors and hashes byte-equally', () => {
    const projection = contract().resolveOrganizationGrokBrokerProjection(input.config, 'foreman', input.options);
    expect(grokBrokerProjectionSchema.parse(projection)).toEqual(projection);
    expect(projection).toEqual(daimonProjectionGolden);
    expect(contract().grokBrokerProjectionSha256(projection)).toBe(daimonProjectionGoldenSha256);
    expect(grokProjectionSha256(grokBrokerProjectionSchema.parse(projection))).toBe(daimonProjectionGoldenSha256);
  });

  it('canonical JSON agrees on key order, unicode, nested arrays and refusals', () => {
    const nullPrototype = Object.assign(Object.create(null) as object, { z: 1, a: [2] });
    const combining = 'e' + String.fromCharCode(0x301);
    const emoji = String.fromCodePoint(0x1f600);
    const separators = String.fromCharCode(0x2028, 0x2029, 0);
    const edges: unknown[] = [{ b: 1, a: 2, B: 3, _: 4, '10': 5, '9': 6 },
      { [String.fromCharCode(0xe9)]: String.fromCharCode(0xfc), e: emoji, [combining]: separators, [emoji]: ['"\\', combining] },
      { nested: [[1, [2, [3, { y: null, x: true }]]], [], [{}]] }, [0.1, 1e21, -5, 2 ** 53 - 1, 'x'], nullPrototype, 'plain', null];
    for (const edge of edges) expect(digest(edge), JSON.stringify(edge)).toBe(contract().grokBrokerProjectionSha256(edge));
    const sparse = [1]; sparse.length = 2;
    const accessor = Object.defineProperty({}, 'a', { get: () => 1, enumerable: true });
    const lone = String.fromCharCode(0xd800), trailing = String.fromCharCode(0xdc00);
    for (const invalid of [lone, { [trailing]: 1 }, sparse, -0, Number.NaN, new Date(0), accessor, { [Symbol('s')]: 1 }, undefined]) {
      expect(accepts(() => canonicalJson(invalid)), String(invalid)).toBe(false);
      expect(accepts(() => contract().grokBrokerProjectionSha256(invalid)), String(invalid)).toBe(false);
    }
  });

  it('slot receipt strictness and freshness match Daimon', () => {
    const projection = contract().resolveOrganizationGrokBrokerProjection(input.config, 'foreman', input.options);
    const valid = slotPreflightFor(daimonProjectionGolden);
    const { nonce: _nonce, ...withoutNonce } = valid;
    const variants: unknown[] = [valid, { ...valid, version: 'noopolis.daimon.grok-slot-preflight.v1' }, { ...valid, worker_uid: 2199 },
      { ...valid, canaries: [...valid.canaries, valid.canaries[0]] }, { ...valid, created_at: '2026-02-30T12:00:00.000Z' }, { ...valid, generation: 0 },
      { ...valid, nonce: 'A'.repeat(64) }, { ...valid, operator: 'root' }, withoutNonce];
    for (const variant of variants) {
      expect(grokSlotPreflightSchema.safeParse(variant).success, JSON.stringify(variant).slice(0, 120)).toBe(accepts(() => contract().parseGrokSlotPreflightReceipt(variant)));
    }
    const fresh = { expectedNonce: fixtureNonce, minGeneration: 3 };
    expect(accepts(() => contract().verifyGrokSlotPreflightReceipt(valid, projection, fresh))).toBe(true);
    expect(() => contract().verifyGrokSlotPreflightReceipt(valid, projection, { ...fresh, expectedNonce: 'b'.repeat(64) })).toThrow('stale: nonce');
    expect(() => contract().verifyGrokSlotPreflightReceipt(valid, projection, { ...fresh, minGeneration: 4 })).toThrow('stale: generation');
  });
});
