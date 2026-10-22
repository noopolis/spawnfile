import { expect, test } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { launchFixture } from '../../test-fixtures.js';
import { grokLaunchFrom } from '../../grok-fixtures.js';
import { readSealedBrokerSeal } from '../../sealed-usage.js';
import { assertFreshNativeEvidence, collectNativeEvidence } from './index.js';
import fixtures from './seal-fixtures.json' with { type: 'json' };

const base = fixtures[0]!.seal;
const lines = (...rows: unknown[]) => rows.map(row => JSON.stringify(row) + '\n').join('');

test('attributes clock evidence to each execution, including failed turns with no usage row', async () => {
  const f = await launchFixture();
  try {
    const launch = await grokLaunchFrom(f.launch, f.root);
    const usageFile = launch.broker.usageLedgerPath;
    const file = join(dirname(usageFile), 'turns.jsonl');
    const source = { engine: 'grok', requestsFile: join(dirname(usageFile), 'requests.jsonl') } as const;
    const read = (execution: string | undefined, others: string[] = []) =>
      collectNativeEvidence(join(f.root, 'runtime'), usageFile, base.agent, execution, base.model, others, source);
    expect(await read(base.wake)).not.toHaveProperty('turnSeals');
    const next = { ...fixtures[1]!.seal, wake: 'next-execution' };
    await writeFile(file, lines(base, next, base));
    expect((await read(base.wake)).turnSeals).toEqual([base]);
    expect((await read(next.wake)).turnSeals).toEqual([next]);
    expect((await read(undefined, [next.wake])).turnSeals).toEqual([base]);
    expect((await read(undefined)).turnSeals).toEqual([base, next]);
    expect(await read('unknown-execution')).not.toHaveProperty('turnSeals');
    // A stale seal alone is still stale evidence, even before the first provider request.
    await expect(assertFreshNativeEvidence(join(f.root, 'runtime'), usageFile, base.agent, base.model, source)).rejects.toThrow('fresh');
    // Validation precedes selection: foreign history never disappears behind attribution.
    await writeFile(file, lines(base, { ...next, agent: 'foreign' }));
    await expect(read(base.wake)).rejects.toThrow('identity');
    await writeFile(file, lines(base, { ...next, provider_clock: { ...next.provider_clock, linesRewritten: -1 } }));
    await expect(read(base.wake)).rejects.toThrow('schema');
    await writeFile(file, lines(fixtures[2]!.seal));
    const legacy = (await read(base.wake)).turnSeals![0]!;
    expect(legacy).not.toHaveProperty('provider_clock');
    expect(legacy).not.toHaveProperty('shell_clock');
    const codex = await collectNativeEvidence(join(f.root, 'runtime'), join(f.root, 'unused.jsonl'), base.agent, base.wake, 'test-model-v1');
    expect(codex).not.toHaveProperty('turnSeals');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('failure recovery preserves clock observations and every refusal without inventing absent measurements', async () => {
  const f = await launchFixture();
  try {
    const launch = await grokLaunchFrom(f.launch, f.root);
    const file = join(dirname(launch.broker.usageLedgerPath), 'turns.jsonl');
    const read = () => readSealedBrokerSeal(launch, { attempts: 1, intervalMs: 0 });
    await writeFile(file, lines(base));
    const observed = await read();
    expect(observed).toMatchObject({ outcome: 'read', rows: [{ shellClock: 'task', providerClock: base.provider_clock,
      mcp: { refusals: base.mcp!.refusals } }] });
    if (observed?.outcome !== 'read') throw new Error('seal was not recovered');
    expect(observed.rows[0]!.providerClock).toEqual(base.provider_clock);
    expect(observed.rows[0]!.mcp!.refusals).toEqual(base.mcp!.refusals);
    await writeFile(file, lines(fixtures[1]!.seal));
    const olderClock = await read();
    if (olderClock?.outcome !== 'read') throw new Error('seal was not recovered');
    expect(olderClock.rows[0]!.providerClock).toEqual(fixtures[1]!.seal.provider_clock);
    expect(olderClock.rows[0]!.providerClock).not.toHaveProperty('linesIgnored');
    await writeFile(file, lines(fixtures[2]!.seal));
    const unobserved = await read();
    if (unobserved?.outcome !== 'read') throw new Error('seal was not recovered');
    expect(unobserved.rows[0]).not.toHaveProperty('providerClock');
    expect(unobserved.rows[0]).not.toHaveProperty('shellClock');
    expect(unobserved.rows[0]).not.toHaveProperty('mcp');
    const zeros = { requests: 0, linesRewritten: 0, requestsWithoutDateLine: 0, linesIgnored: 0, injectedDate: null, taskDate: null };
    await writeFile(file, lines({ ...fixtures[2]!.seal, provider_clock: zeros }));
    expect(await read()).toMatchObject({ outcome: 'read', rows: [{ providerClock: zeros }] });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
