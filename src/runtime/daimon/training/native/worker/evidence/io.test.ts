import { expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { files, jsonLines, object, readJson, settleNativeRead, timestamp, wakeEvidenceFile, writeEvidence } from './io.js';

async function scratch(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(join(tmpdir(), 'native-json-'));
  try { await run(root); } finally { vi.restoreAllMocks(); syncBuiltinESMExports(); await fs.rm(root, { recursive: true, force: true }); }
}

test.each(['', '{"private-canary":', '{"private-canary":\n'])('JSON document settles after an incomplete publication: %j', initial => scratch(async root => {
  const file = join(root, 'receipt.json');
  await fs.writeFile(file, initial);
  const reading = readJson(file, 'tool receipt', 65536);
  await new Promise(resolve => setTimeout(resolve, 60));
  await fs.writeFile(file, '{"complete":true}');
  expect(await reading).toEqual({ complete: true });
}));

test('permanent corruption expires with a kind and no evidence contents', () => scratch(async root => {
  const file = join(root, 'receipt.json');
  await fs.writeFile(file, '{private-canary}');
  const started = performance.now();
  await expect(readJson(file, 'tool receipt', 65536)).rejects.toThrow(/^Native tool receipt JSON did not settle before deadline/);
  expect(performance.now() - started).toBeGreaterThanOrEqual(990);
  await expect(readJson(file, 'tool receipt', 1)).rejects.toThrow('Unsafe or oversized');
}));

test.each(['{"row":', '{"row":\n'])('JSONL rereads the whole incomplete stream: %j', initial => scratch(async root => {
  const file = join(root, 'turns.ndjson');
  await fs.writeFile(file, '{"first":1}\n' + initial);
  const reading = jsonLines(file, 'closed trace telemetry');
  await new Promise(resolve => setTimeout(resolve, 60));
  await fs.writeFile(file, '{"first":1}\n{"row":2}\n');
  expect(await reading).toEqual([{ first: 1 }, { row: 2 }]);
}));

test.each(['empty', 'missing'])('an observed torn stream cannot erase itself by becoming %s', state => scratch(async root => {
  const file = join(root, 'turns.ndjson');
  await fs.writeFile(file, '{');
  const reading = expect(jsonLines(file, 'closed trace telemetry')).rejects.toThrow('Native closed trace telemetry JSON did not settle');
  await new Promise(resolve => setTimeout(resolve, 60));
  if (state === 'empty') await fs.writeFile(file, ''); else await fs.rm(file);
  await reading;
}));

test('empty and missing ledgers are absent before the first row; unsafe files and bounds still fail', () => scratch(async root => {
  const file = join(root, 'usage.jsonl');
  expect(await jsonLines(file, 'token usage ledger')).toEqual([]);
  await fs.writeFile(file, '');
  expect(await jsonLines(file, 'token usage ledger')).toEqual([]);
  await fs.writeFile(file, '{}\n');
  await expect(jsonLines(file, 'token usage ledger', 100, 2)).rejects.toThrow('Native token usage ledger record exceeds');
  await fs.symlink(file, join(root, 'link'));
  await expect(jsonLines(join(root, 'link'), 'token usage ledger')).rejects.toThrow('Unsafe');
  expect(await files(join(root, 'absent'))).toEqual([]);
  await expect(files(file)).rejects.toThrow('must be real');
  await expect(files(join(root, 'link'))).rejects.toThrow('must be real');
  expect(await files(root)).toContain('usage.jsonl');
}));

test('settle retries only syntax faults and has a bounded deadline', async () => {
  const error = new Error('permission denied');
  await expect(settleNativeRead('receipt', async () => { throw error; })).rejects.toBe(error);
  await expect(settleNativeRead('receipt', async () => { throw new SyntaxError('private-canary'); }, 0))
    .rejects.toThrow(/^Native receipt JSON did not settle before deadline/);
  expect(object({})).toEqual({});
  for (const value of [null, [], 1]) expect(() => object(value)).toThrow('Malformed');
  expect(timestamp('2026-09-13T00:00:00Z')).toBe(true);
  expect(timestamp('no')).toBe(false);
  expect(timestamp(null)).toBe(false);
  expect(wakeEvidenceFile('/evidence.json', 2)).toBe('/evidence.2.json');
  expect(wakeEvidenceFile('/evidence', 2)).toBe('/evidence.2');
  expect(() => wakeEvidenceFile('/evidence', 0)).toThrow('ordinal');
});

test('terminal evidence is published only after the temporary file is complete', () => scratch(async root => {
  const file = join(root, 'evidence.json');
  const value = { complete: 'x'.repeat(100_000) };
  await fs.writeFile(file, '{"old":true}\n');
  const rename = fs.rename;
  const publishing = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
    expect(target).toBe(file);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ old: true });
    expect(JSON.parse(await fs.readFile(source, 'utf8'))).toEqual(value);
    expect((await fs.stat(source)).mode & 0o777).toBe(0o600);
    await rename(source, target);
  });
  syncBuiltinESMExports();
  await writeEvidence(file, value);
  expect(publishing).toHaveBeenCalledOnce();
  expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(value);
  expect(await fs.readdir(root)).toEqual(['evidence.json']);
}));

test.each(['malformed', 'different'])('terminal evidence readback refuses %s bytes without quoting them', variant => scratch(async root => {
  const file = join(root, 'evidence.json');
  vi.spyOn(fs, 'readFile').mockResolvedValue(variant === 'malformed' ? '{private-canary' : '{}');
  syncBuiltinESMExports();
  await expect(writeEvidence(file, { complete: true })).rejects.toThrow(variant === 'malformed'
    ? 'Native terminal evidence JSON readback failed' : 'Native evidence readback differs');
}));

test('an existing empty stream expected to contain closed work settles rather than passing as absence', () => scratch(async root => {
  const file = join(root, 'usage.jsonl');
  const read = () => jsonLines(file, 'token usage ledger', undefined, undefined, true);
  // Missing optional observations stay absent; an existing empty file can be a writer's open window.
  expect(await read()).toEqual([]);
  await fs.writeFile(file, '');
  const reading = read();
  await new Promise(resolve => setTimeout(resolve, 60));
  await fs.writeFile(file, '{}\n');
  expect(await reading).toEqual([{}]);
  await fs.writeFile(file, '');
  await expect(read()).rejects.toThrow('Native token usage ledger JSON did not settle before deadline');
}));
