import { expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isGrokLaunch, parseNativeLaunch } from './schema.js';
import { launchFixture } from '../test-fixtures.js';
import { grokLaunchFrom } from '../grok-fixtures.js';

test('strict versioned receipts reject mutable images, path escapes, unsupported engines and undeclared overrides', async () => {
  const f = await launchFixture();
  try {
    const { receiptFile: _, ...valid } = f.launch;
    expect(parseNativeLaunch(valid)).toEqual(valid);
    for (const mutation of [null, [], { ...valid, extra: true }, { ...valid, schema: 'unknown' }, { ...valid, image: 'latest' },
      { ...valid, config: 'relative' }, { ...valid, config: '/with,comma' }, { ...valid, configSha256: 'unknown' },
      { ...valid, workspace: { ...valid.workspace, target: '/a/../b' } },
      ...['../AGENTS.md', '/AGENTS.md', '..', 'a/../b', 'a\\b'].map(relativePath => ({ ...valid, instructions: { ...valid.instructions, relativePath } })),
      { ...valid, agent: { ...valid.agent, engine: 'other' } }, { ...valid, projections: [] },
      { ...valid, projections: [...valid.projections, valid.projections[0]] },
      { ...valid, limits: { maxTokens: 1, wakeTokenCeiling: 2 } },
      { ...valid, overrides: { ...valid.overrides, selection: { ...valid.overrides.selection, after: ['wrong'] } } },
      { ...valid, overrides: { ...valid.overrides, selection: { ...valid.overrides.selection, before: ['wrong'] } } },
    ]) expect(() => parseNativeLaunch(mutation)).toThrow();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('launch v2 selects Codex or Grok and v1 receipts still parse as Codex', async () => {
  const f = await launchFixture();
  try {
    const { receiptFile: _, ...v1 } = structuredClone(f.launch);
    const parsedV1 = parseNativeLaunch(v1);
    expect(parsedV1.schema).toBe('paideia.daimon-native.launch.v1');
    expect(parsedV1.agent.engine).toBe('codex');
    expect(isGrokLaunch(parsedV1)).toBe(false);
    expect(parseNativeLaunch({ ...v1, schema: 'paideia.daimon-native.launch.v2' }).agent.engine).toBe('codex');
    expect(() => parseNativeLaunch({ ...v1, agent: { ...v1.agent, reasoningEffort: 'low' } })).toThrow();
    const grok = await grokLaunchFrom(f.launch, f.root);
    const { receiptFile: __, ...valid } = grok;
    const parsed = parseNativeLaunch(valid);
    expect(parsed).toEqual(valid);
    expect(isGrokLaunch(parsed)).toBe(true);
    const credential = { source: join(f.root, 'auth'), target: '/native/home/.daimon-inbound/codex-auth' };
    const broker = valid.broker;
    /** Re-homes one evaluator root and keeps the deny list consistent with it. */
    const moved = (role: string, path: string) => ({ ...valid, broker: { ...broker, denyPaths: [...broker.denyPaths, path],
      evaluatorPaths: broker.evaluatorPaths.map(row => row.role === role ? { ...row, path } : row) } });
    for (const mutation of [
      { ...valid, schema: 'paideia.daimon-native.launch.v1' },
      { ...valid, credentials: [credential] },
      { ...valid, broker: undefined },
      { ...valid, agent: { ...valid.agent, model: 'gpt-5.5' } },
      { ...valid, agent: { ...valid.agent, reasoningEffort: undefined } },
      { ...valid, agent: { ...valid.agent, reasoningEffort: 'xhigh' } },
      { ...valid, broker: { ...broker, projectionSha256: 'bad' } },
      { ...valid, broker: { ...broker, workerUid: 2000 } },
      { ...valid, broker: { ...broker, workerConfigVariant: undefined } },
      { ...valid, broker: { ...broker, workerConfigVariant: 'unknown' } },
      { ...valid, broker: { ...broker, projectionVersion: 'noopolis.daimon.grok-broker-projection.v1' } },
      { ...valid, broker: { ...broker, projectionVersion: 'noopolis.daimon.grok-broker-projection.v0' } },
      { ...valid, broker: { ...broker, evaluatorPaths: broker.evaluatorPaths.filter(row => row.role !== 'judge-home') } },
      { ...valid, broker: { ...broker, evaluatorPaths: [...broker.evaluatorPaths.slice(1), { ...broker.evaluatorPaths[1]!, role: 'run-root' }] } },
      // Moving a root without listing it stops at the deny-list guard; the three below list it too, so
      // each reaches the guard it is meant to exercise instead of short-circuiting on the earlier one.
      { ...valid, broker: { ...broker, evaluatorPaths: broker.evaluatorPaths.map(row => row.role === 'context' ? { ...row, path: '/native/elsewhere' } : row) } },
      moved('slot-ledger', f.root),
      moved('context', '/native/workspace/context'),
      moved('context', '/native'),
      { ...valid, broker: { ...broker, limits: { ...broker.limits, maxTokens: valid.limits.wakeTokenCeiling + 1 } } },
      { ...valid, broker: { ...broker, extra: true } },
      { ...valid, broker: { ...broker, expectedNonce: undefined } },
      { ...valid, broker: { ...broker, expectedNonce: 'B'.repeat(64) } },
      { ...valid, broker: { ...broker, minGeneration: 0 } },
    ]) expect(() => parseNativeLaunch(mutation), JSON.stringify(mutation).slice(0, 80)).toThrow();
    const clocked = { ...valid, taskClock: { origin: '2024-02-29T00:00:00Z', anchorEpochMs: Date.now(), libfaketimePath: '/usr/local/lib/daimon/libfaketime.so.1' } };
    expect(() => parseNativeLaunch(clocked)).toThrow('taskClock requires workerConfigVariant: clocked');
    expect(parseNativeLaunch({ ...clocked, broker: { ...broker, workerConfigVariant: 'clocked' } }).taskClock).toEqual(clocked.taskClock);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
