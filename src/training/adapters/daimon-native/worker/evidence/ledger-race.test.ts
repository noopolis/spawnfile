import { expect, test } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectNativeEvidence, readSealedGrokRequests, readSealedGrokTurnSeals, readSealedGrokUsage } from './index.js';
import { traceFixture } from '../../test-fixtures.js';
import fixtures from './seal-fixtures.json' with { type: 'json' };

const usage = { v: 'noopolis.daimon.turn-usage.v1', agent: 'agent:writer', wake: 'execution', engine: 'grok',
  at: '2026-09-17T00:00:02.000Z', input: 10, output: 2, cache_read: 0, cache_write: 0, total: 12,
  notional_usd: 0.01, complete: true, turn: 'a'.repeat(64), model: 'grok-4.6' };
const request = { v: 'noopolis.daimon.turn-requests.v1', agent: usage.agent, wake: usage.wake, engine: usage.engine,
  at: usage.at, turn: usage.turn, model: usage.model, request: 0, requests: 1, input: 10, cached_input: 0,
  fresh_input: 10, cache_write: 0, output: 2, total: 12 };
const ledgers = [
  { kind: 'Grok usage ledger', read: readSealedGrokUsage, row: usage },
  { kind: 'Grok request ledger', read: readSealedGrokRequests, row: request },
  { kind: 'Grok turn seal ledger', read: readSealedGrokTurnSeals, row: fixtures[0]!.seal },
];

test.each(ledgers)('$kind settles a concurrent append and permanently corrupt JSON still fails', async ({ kind, read, row }) => {
  const root = await mkdtemp(join(tmpdir(), 'native-ledger-race-'));
  const file = join(root, 'ledger.jsonl');
  let publishing: Promise<void> | undefined;
  try {
    await writeFile(file, '{"partial":');
    const reading = read(file, usage.agent, usage.model);
    publishing = new Promise<void>(resolve => setTimeout(resolve, 60)).then(() => writeFile(file, JSON.stringify(row) + '\n'));
    expect(await reading).toEqual([row]);
    await writeFile(file, '{private-canary}\n');
    await expect(read(file, usage.agent, usage.model)).rejects.toThrow(`Native ${kind} JSON did not settle before deadline`);
  } finally { await publishing; await rm(root, { recursive: true, force: true }); }
});


test('Grok closed-work collection settles an empty usage file and refuses one that stays empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-grok-empty-'));
  const file = join(root, 'usage.jsonl');
  let publishing: Promise<void> | undefined;
  try {
    await mkdir(join(root, 'telemetry'));
    await writeFile(join(root, 'telemetry/turns.ndjson'), JSON.stringify(traceFixture()) + '\n');
    await writeFile(file, '');
    const read = () => collectNativeEvidence(root, file, usage.agent, undefined, usage.model, [],
      { engine: 'grok', requestsFile: join(root, 'requests.jsonl') });
    const reading = read();
    publishing = new Promise<void>(resolve => setTimeout(resolve, 60)).then(() => writeFile(file, JSON.stringify(usage) + '\n'));
    expect((await reading).usage).toEqual([usage]);
    await writeFile(file, '');
    await expect(read()).rejects.toThrow('Native Grok usage ledger JSON did not settle before deadline');
  } finally { await publishing; await rm(root, { recursive: true, force: true }); }
});
