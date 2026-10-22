import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, grokBrokerProjectionSchema, grokProjectionSha256, grokSlotPreflightSchema, grokWorkerConfigPins } from './grok.js';
import { grokModels, grokReasoningEfforts } from './schema.js';
import { daimonGrokInferenceClientPin } from '../grants/index.js';
import { daimonProjectionGolden, daimonProjectionGoldenSha256, daimonClockedProjectionGolden, daimonClockedProjectionGoldenSha256,
  fixtureNonce, slotPreflightFor } from '../grok-fixtures.js';

/** Pins Paideia's Daimon-free mirrors to the installed Daimon contract; Daimon is an optional peer, absent in plain CI installs. */
interface DaimonGrokContract {
  resolveOrganizationGrokBrokerProjection(config: unknown, agentId: string, options: unknown): unknown;
  grokBrokerProjectionSha256(value: unknown): string;
  parseGrokSlotPreflightReceipt(value: unknown): unknown;
  verifyGrokSlotPreflightReceipt(value: unknown, projection: unknown, freshness: unknown): unknown;
  renderGrokInferenceClientConfig(input: { model: string; reasoningEffort: string; baseUrl: string; envKey: string }): string;
}
const required = ['resolveOrganizationGrokBrokerProjection', 'grokBrokerProjectionSha256', 'parseGrokSlotPreflightReceipt',
  'verifyGrokSlotPreflightReceipt', 'renderGrokInferenceClientConfig'] as const;
let daimon: DaimonGrokContract | undefined;
const packageName = '@noopolis/daimon/runtime';
let installed = false;
try {
  import.meta.resolve(packageName);
  installed = true;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw error;
}
if (installed) {
  // An installed but incompatible peer is a contract failure, never a skipped check.
  const loaded = await import(packageName) as Record<string, unknown>;
  if (!required.every(name => typeof loaded[name] === 'function')) throw new Error('Installed Daimon lacks the required Grok contract exports');
  daimon = loaded as unknown as DaimonGrokContract;
}
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
const variants = [
  { variant: 'unclocked', golden: daimonProjectionGolden, sha256: daimonProjectionGoldenSha256 },
  { variant: 'clocked', golden: daimonClockedProjectionGolden, sha256: daimonClockedProjectionGoldenSha256 },
] as const;

describe.skipIf(!daimon)('Daimon Grok contract parity (skipped only when @noopolis/daimon/runtime is absent)', () => {
  it('keeps the separate evaluator inference config pins unchanged under manifest v5', () => {
    const pin = daimonGrokInferenceClientPin;
    for (const model of grokModels) for (const reasoningEffort of grokReasoningEfforts) {
      const bytes = contract().renderGrokInferenceClientConfig({ model, reasoningEffort, baseUrl: pin.proxyBaseUrl, envKey: pin.envKey });
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(pin.configSha256[model][reasoningEffort]);
    }
  });

  it.each(variants)('resolves the $variant fixture projection that Paideia mirrors and hashes byte-equally', ({ variant, golden, sha256 }) => {
    const projection = contract().resolveOrganizationGrokBrokerProjection(input.config, 'foreman', { ...input.options, workerConfigVariant: variant });
    expect(grokBrokerProjectionSchema.parse(projection)).toEqual(projection);
    expect(projection).toEqual(golden);
    expect(contract().grokBrokerProjectionSha256(projection)).toBe(sha256);
    expect(grokProjectionSha256(grokBrokerProjectionSchema.parse(projection))).toBe(sha256);
    if (variant === 'unclocked') expect(contract().resolveOrganizationGrokBrokerProjection(input.config, 'foreman', input.options)).toEqual(golden);
  });

  it.each(variants)('accepts every $variant model/effort config unchanged and refuses pin drift', ({ variant }) => {
    for (let slot = 0; slot < 8; slot++) for (const model of grokModels) for (const reasoningEffort of grokReasoningEfforts) {
      const config = structuredClone(input.config);
      config.agents[0]!.engine = { kind: 'grok', model, reasoningEffort };
      const projection = contract().resolveOrganizationGrokBrokerProjection(config, 'foreman', { ...input.options, slot, workerUid: 2200 + slot,
        workerHomePath: `/var/lib/daimon-workers/${2200 + slot}`, workerConfigVariant: variant });
      const parsed = grokBrokerProjectionSchema.parse(projection);
      expect(parsed).toEqual(projection);
      if (slot === 0) expect(parsed.workerConfigSha256).toBe(grokWorkerConfigPins[variant][model][reasoningEffort]);
      expect(grokProjectionSha256(parsed)).toBe(contract().grokBrokerProjectionSha256(projection));
      expect(() => grokBrokerProjectionSchema.parse({ ...parsed, workerConfigSha256: 'f'.repeat(64) })).toThrow('pinned variant/model/effort');
      if (variant === 'clocked') {
        expect(() => grokBrokerProjectionSchema.parse({ ...parsed, taskClock: { ...parsed.taskClock,
          timestampFilePath: `/run/daimon-engine-broker/task-clock/slot-${(slot + 1) % 8}/faketime` } })).toThrow('belong to its slot');
      }
    }
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

  it.each(variants)('$variant slot receipt strictness and freshness match Daimon', ({ variant, golden }) => {
    const projection = contract().resolveOrganizationGrokBrokerProjection(input.config, 'foreman', { ...input.options, workerConfigVariant: variant });
    const valid = slotPreflightFor(golden);
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
