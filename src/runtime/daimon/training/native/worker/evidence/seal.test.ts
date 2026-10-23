import { expect, test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fixtures from './seal-fixtures.json' with { type: 'json' };
import { parseNativeTurnSeal } from './seal.js';
import { readSealedGrokTurnSeals } from './index.js';

const base = fixtures[0]!.seal;
const clock = base.provider_clock!;
const mcp = base.mcp!;
const diagnostic = base.diagnostic!;
const parse = (row: unknown) => parseNativeTurnSeal(row, 'agent:writer', 'grok-4.6');

test.each(fixtures)('static CI seal fixture: $name', fixture => {
  expect(parse(fixture.seal)).toEqual(fixture.seal);
});

test('preserves legacy absence, observed zero, closed vocabularies and the writer bounds', () => {
  expect(parse(fixtures[2]!.seal)).not.toHaveProperty('provider_clock');
  expect(parse({ ...base, provider_clock: { requests: 0, linesRewritten: 0, requestsWithoutDateLine: 0, injectedDate: null, taskDate: null } }).provider_clock)
    .toEqual({ requests: 0, linesRewritten: 0, requestsWithoutDateLine: 0, injectedDate: null, taskDate: null });
  for (const shell_clock of ['real', 'task', 'gap']) expect(parse({ ...base, shell_clock }).shell_clock).toBe(shell_clock);
  for (const code of ['auth_stale', 'cancelled', 'engine_failed', 'invalid_request', 'limit_exceeded', 'turn_conflict', 'unavailable']) {
    expect(parse({ ...base, code, limit_reason: code === 'limit_exceeded' ? 'tokens' : 'none' }).code).toBe(code);
  }
  for (const limit_reason of ['tokens', 'requests', 'timeout']) expect(parse({ ...base, limit_reason }).limit_reason).toBe(limit_reason);
  for (const model of ['grok-4.6', 'grok-4.5', 'grok-build']) {
    expect(parseNativeTurnSeal({ ...base, model }, base.agent, model).model).toBe(model);
  }
  expect(parse({ ...base, requests: 1024, turn: 'turn-1', wake: 'w'.repeat(128) }).turn).toBe('turn-1');
  const bounded = { ...mcp, started: 16, answered: 0, undecoded: Number.MAX_SAFE_INTEGER,
    outstanding: Array.from({ length: 16 }, (_, index) => ({ name: index === 0 ? '<invalid>' : index === 1 ? '<truncated>' : 't'.repeat(64), outstanding_ms: Number.MAX_SAFE_INTEGER })),
    tunnels: { opened: 8, closed: 0, delivered: 8, open: Array.from({ length: 8 }, () => ({ open_ms: 0, delivered: true })) } };
  expect(parse({ ...base, mcp: bounded }).mcp).toEqual(bounded);
  expect(parse({ ...base, mcp: { started: 0, answered: 0, undecoded: 0, outstanding: [] } }).mcp).toEqual({ started: 0, answered: 0, undecoded: 0, outstanding: [] });
  // One request may contain multiple injected lines; failed rewrites still count requests.
  expect(parse({ ...base, provider_clock: { ...clock, requests: 1, linesRewritten: 4, requestsWithoutDateLine: 0 } }).provider_clock?.linesRewritten).toBe(4);
});

test('accepts exactly the diagnostic combinations projected by the terminal protocol', () => {
  for (const [stage, failure_class] of [['peer', 'peer'], ['request', 'protocol'], ['registration', 'registration'], ['executable', 'executable'], ['exec', 'exec']]) {
    expect(parse({ ...base, diagnostic: { status: 'prelaunch_failed', stage, failure_class, exit_code: -1, term_signal: -1 } }).diagnostic?.stage).toBe(stage);
  }
  for (const failure_class of ['profile_missing', 'profile_invalid']) {
    expect(parse({ ...base, diagnostic: { status: 'worker_failed', stage: 'attestation', failure_class, exit_code: 0, term_signal: 0 } }).diagnostic?.failure_class).toBe(failure_class);
  }
  for (const failure_class of ['exec', 'wait']) {
    expect(parse({ ...base, diagnostic: { ...diagnostic, status: 'worker_failed', stage: 'wait', failure_class } }).diagnostic?.failure_class).toBe(failure_class);
  }
  expect(parse({ ...base, diagnostic: { ...diagnostic, status: 'output_failed', stage: 'output', failure_class: 'output_limit', reason: 'é'.repeat(384) } }).diagnostic?.reason).toHaveLength(384);
});

test.each([
  { injected: true }, { cleanupDiagnostic: 'task clock reset failed; slot fenced until restart' },
  { cleanup_diagnostic: 'task clock reset failed; slot fenced until restart' },
  { v: 'other' }, { agent: 'other' }, { engine: 'codex' }, { wake: '' }, { wake: 'w'.repeat(129) },
  { turn: 'invalid/turn' }, { turn: 't'.repeat(129) }, { at: 'yesterday' }, { outcome: 'cancelled' },
  { model: 'grok-4.6-build' }, { model: 'grok-4.5' }, { requests: 1025 }, { requests: -1 }, { requests: 0.5 },
  { limit_reason: 'budget' }, { code: 'invented' }, { code: 'cancelled' }, { limit_reason: 'none' },
  { shell_clock: 'unknown' }, { shell_clock: null }, { provider_clock: null }, { mcp: null }, { diagnostic: null },
])('rejects unknown or inconsistent seal members: %j', patch => {
  expect(() => parse({ ...base, ...patch })).toThrow('Native Grok seal');
});

test('rejects failed-only observations on completed rows and mismatched failure codes', () => {
  const completed = fixtures[1]!.seal;
  for (const patch of [{ code: 'cancelled' }, { mcp }, { diagnostic }, { limit_reason: 'requests' }]) {
    expect(() => parse({ ...completed, ...patch })).toThrow();
  }
  expect(() => parse({ ...base, code: undefined })).toThrow();
});

test('requires every measured member and refuses extra fields at every nesting level', () => {
  const scopes = [
    { path: [], keys: ['v', 'agent', 'wake', 'engine', 'at', 'turn', 'outcome', 'requests', 'model', 'limit_reason', 'code'] },
    { path: ['diagnostic'], keys: ['status', 'stage', 'failure_class', 'exit_code', 'term_signal'] },
    { path: ['provider_clock'], keys: ['requests', 'linesRewritten', 'requestsWithoutDateLine', 'injectedDate', 'taskDate'] },
    { path: ['mcp'], keys: ['started', 'answered', 'undecoded', 'outstanding'] },
    { path: ['mcp', 'refusals'], keys: ['route', 'expired', 'exhausted', 'unrouted', 'oversized'] },
    { path: ['mcp', 'tunnels'], keys: ['opened', 'closed', 'delivered', 'open'] },
    { path: ['mcp', 'tunnels', 'open', '0'], keys: ['open_ms', 'delivered'] },
    { path: ['mcp', 'outstanding', '0'], keys: ['name', 'outstanding_ms'] },
  ];
  for (const { path, keys } of scopes) for (const key of [...keys, 'unknown']) {
    const row = structuredClone(base);
    let object = row as unknown as Record<string, unknown>;
    for (const name of path) object = object[name] as Record<string, unknown>;
    if (key === 'unknown') object[key] = 'untrusted'; else delete object[key];
    expect(() => parse(row), `${path.join('.')}.${key}`).toThrow();
  }
});

test('refusal counts and provider counters are nonnegative safe integers, never partial measurements', () => {
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, '0']) {
    for (const key of Object.keys(mcp.refusals)) {
      expect(() => parse({ ...base, mcp: { ...mcp, refusals: { ...mcp.refusals, [key]: value } } })).toThrow();
    }
    for (const key of ['requests', 'linesRewritten', 'requestsWithoutDateLine', 'linesIgnored']) {
      expect(() => parse({ ...base, provider_clock: { ...clock, [key]: value } })).toThrow();
    }
  }
});

test.each([
  { status: 'other' }, { stage: 'other' }, { failure_class: 'other' }, { exit_code: 0.5 }, { term_signal: Number.MAX_SAFE_INTEGER + 1 },
  { status: 'prelaunch_failed', stage: 'peer', failure_class: 'peer' },
  { status: 'prelaunch_failed', stage: 'peer', failure_class: 'exec', reason: undefined },
  { status: 'worker_failed', stage: 'attestation', failure_class: 'profile_missing' },
  { status: 'worker_failed', stage: 'attestation', failure_class: 'peer', reason: undefined },
  { status: 'worker_failed', stage: 'peer' }, { status: 'worker_failed', failure_class: 'peer' },
  { status: 'output_failed', stage: 'wait', failure_class: 'output_limit' },
  { status: 'output_failed', stage: 'output', failure_class: 'exec' }, { stage: 'peer' }, { failure_class: 'peer' },
  { reason: '' }, { reason: 'é'.repeat(385) }, { reason: 'line\nbreak' }, { reason: 'bad\u007f' }, { reason: 'bad\u0000' },
])('rejects non-protocol diagnostic: %j', patch => {
  expect(() => parse({ ...base, diagnostic: { ...diagnostic, ...patch } })).toThrow();
});

test.each([
  { requestsWithoutDateLine: 4 }, { requestsWithoutDateLine: 3 }, { linesRewritten: 0 },
  { injectedDate: null }, { taskDate: null }, { taskDate: '2020-1-2' }, { injectedDate: 'not a date' },
])('rejects inconsistent provider observations: %j', patch => {
  expect(() => parse({ ...base, provider_clock: { ...clock, ...patch } })).toThrow();
});

test.each([
  { answered: 3 }, { started: 1 }, { started: -1 }, { undecoded: 1.5 },
  { outstanding: Array.from({ length: 17 }, () => ({ name: 'tool', outstanding_ms: 1 })), started: 100 },
  { outstanding: [{ name: 'tool name', outstanding_ms: 1 }] }, { outstanding: [{ name: 't'.repeat(65), outstanding_ms: 1 }] },
  { outstanding: [{ name: 'tool', outstanding_ms: -1 }] },
  { tunnels: { opened: 1, closed: 2, delivered: 0, open: [] } },
  { tunnels: { opened: 1, closed: 0, delivered: 2, open: [] } },
  { tunnels: { opened: 1, closed: 1, delivered: 0, open: [{ open_ms: 1, delivered: false }] } },
  { tunnels: { opened: 9, closed: 0, delivered: 0, open: Array.from({ length: 9 }, () => ({ open_ms: 1, delivered: false })) } },
  { tunnels: { opened: 1, closed: 0, delivered: 0, open: [{ open_ms: -1, delivered: false }] } },
  { tunnels: { opened: 1, closed: 0, delivered: 0, open: [{ open_ms: 1, delivered: 1 }] } },
])('rejects MCP bounds or inconsistent observations: %j', patch => {
  expect(() => parse({ ...base, mcp: { ...mcp, ...patch } })).toThrow();
});

test('bounds raw seal lines and refuses conflicting replays before selecting an execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seal-bounds-'));
  const file = join(root, 'turns.jsonl');
  const read = () => readSealedGrokTurnSeals(file, base.agent, base.model);
  const row = JSON.stringify(base);
  try {
    await writeFile(file, `${row}\n${row}\n`);
    expect(await read()).toEqual([base]);
    await writeFile(file, `${row}\n${JSON.stringify({ ...base, requests: 4 })}\n`);
    await expect(read()).rejects.toThrow('Conflicting');
    await writeFile(file, `${row}\n${JSON.stringify(Object.fromEntries(Object.entries(base).reverse()))}\n`);
    await expect(read()).rejects.toThrow('Conflicting');
    await writeFile(file, row.padEnd(8191, ' ') + '\n');
    expect(await read()).toEqual([base]);
    await writeFile(file, row.padEnd(8192, ' ') + '\n');
    await expect(read()).rejects.toThrow('byte bound');
    await writeFile(file, row);
    await expect(read()).rejects.toThrow('torn');
  } finally { await rm(root, { recursive: true, force: true }); }
});
