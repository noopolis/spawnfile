import { lstat, readdir, readFile, rename, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readPrivateFile } from '../receipt/index.js';
import type { NativeCodexUsage, NativeEvidence, NativeEvidenceSource, NativeGrokUsage, NativeRequestUsage, NativeTrace, NativeTurnSeal } from './types.js';

const MAX_STREAM = 64 * 1024 * 1024;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed native evidence record');
  return value as Record<string, unknown>;
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}
async function jsonLines(file: string, maximum = MAX_STREAM): Promise<unknown[]> {
  let source: string;
  try { source = await readPrivateFile(file, maximum); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  if (source && !source.endsWith('\n')) throw new Error('Native evidence stream has a torn final record');
  return source.split('\n').filter(Boolean).map(line => JSON.parse(line) as unknown);
}

export async function readClosedTraces(runtimeHome: string, agentId: string): Promise<NativeTrace[]> {
  return (await jsonLines(join(runtimeHome, 'telemetry', 'turns.ndjson'))).map(value => {
    const row = object(value);
    if (row.schema !== 'daimon.turn_trace.v1' || row.agent_id !== agentId || typeof row.turn_id !== 'string' ||
        !timestamp(row.started_at) || !timestamp(row.completed_at) || Date.parse(row.completed_at) < Date.parse(row.started_at) ||
        !['completed', 'failed'].includes(String(row.status)) || !Array.isArray(row.tools)) {
      throw new Error('Native trace schema, agent or terminal identity mismatch');
    }
    return row as NativeTrace;
  });
}

async function readUsage(file: string, agentId: string, executionId?: string, previous: readonly string[] = []): Promise<NativeCodexUsage[]> {
  const wakes = new Set<string>();
  return (await jsonLines(file)).map(value => {
    const row = object(value);
    if (row.v !== 'noopolis.daimon.turn-usage.v1' || row.agent !== agentId || row.engine !== 'codex' ||
        typeof row.wake !== 'string' || executionId !== undefined && row.wake !== executionId && !previous.includes(String(row.wake)) || !timestamp(row.at) ||
        typeof row.complete !== 'boolean' || ['input', 'output', 'cache_read', 'total'].some(key =>
          !Number.isSafeInteger(row[key]) || Number(row[key]) < 0)) throw new Error('Native usage schema or execution identity mismatch');
    // This Codex contract reports one terminal total per execution, not deltas.
    if (wakes.has(row.wake)) throw new Error('Duplicate native usage execution');
    wakes.add(row.wake);
    if (Number(row.cache_read) > Number(row.input) || Number(row.total) !== Number(row.input) + Number(row.output)) {
      throw new Error('Native Codex token totals or cache subset are inconsistent');
    }
    return row as NativeCodexUsage;
  }).filter(row => !previous.includes(row.wake));
}

/** Complete observed terminal usage requires one matching, closed native execution. */
export function nativeUsageCoverage(native: NativeEvidence, executionId?: string): 'complete' | 'partial' | 'absent' {
  if (!native.usage.length) return 'absent';
  const usage = native.usage[0]!;
  const trace = native.traces[0];
  // A Grok request charged an estimate is bounded spend, not observed usage: either ledger saying so is enough.
  const estimated = usage.engine === 'grok' && ((usage.estimated_requests ?? 0) > 0 || (native.requests ?? []).some(row => row.usage_source === 'estimated'));
  return executionId !== undefined && native.usage.length === 1 && native.traces.length === 1 && !estimated
    && usage.wake === executionId && usage.complete && trace?.turn_id === executionId && trace.status === 'completed'
    ? 'complete' : 'partial';
}

async function files(directory: string): Promise<string[]> {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Native evidence directory must be real');
    return await readdir(directory);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

export async function readToolReceipts(runtimeHome: string, agentId: string, engine: NativeEvidenceSource['engine'] = 'codex'): Promise<Record<string, unknown>[]> {
  const directory = join(runtimeHome, 'tool-state');
  const entries = (await files(directory)).filter(name => /^[a-f0-9]{64}\.json$/u.test(name));
  if (entries.length > 2048) throw new Error('Native tool receipt count exceeds its bound');
  return Promise.all(entries.sort().map(async name => {
    const row = object(JSON.parse(await readPrivateFile(join(directory, name), 65536)));
    if (row.agent_id !== agentId || row.engine !== engine || !['mcp', 'moltnet'].includes(String(row.kind)) ||
        typeof row.delivery_id !== 'string' || !timestamp(row.at)) throw new Error('Native tool receipt identity mismatch');
    if (row.kind === 'mcp' && (typeof row.server !== 'string' || typeof row.tool !== 'string' || typeof row.is_error !== 'boolean')) {
      throw new Error('Malformed native MCP receipt');
    }
    return row;
  }));
}

async function readModelContexts(runtimeHome: string): Promise<NativeEvidence['modelContexts']> {
  const contexts: NativeEvidence['modelContexts'] = [];
  let count = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 4) throw new Error('Unexpected native session directory depth');
    for (const name of await files(directory)) {
      const file = join(directory, name);
      const entry = await lstat(file);
      if (entry.isSymbolicLink()) throw new Error('Native session evidence must not use symlinks');
      if (entry.isDirectory()) { await visit(file, depth + 1); continue; }
      if (!name.endsWith('.jsonl')) continue;
      if (++count > 8) throw new Error('Native session count exceeds the isolated trial bound');
      for (const value of await jsonLines(file)) {
        const row = object(value);
        if (row.type !== 'turn_context') continue;
        const payload = object(row.payload);
        if (typeof payload.model !== 'string') throw new Error('Native model context omitted its model');
        contexts.push({ model: payload.model, approvalPolicy: payload.approval_policy ?? null, sandboxPolicy: payload.sandbox_policy ?? null });
      }
    }
  };
  await visit(join(runtimeHome, '.codex', 'sessions'), 0);
  return contexts;
}

export async function collectNativeEvidence(runtimeHome: string, usageFile: string, agentId: string,
  executionId: string | undefined, expectedModel: string, previous: readonly string[] = [],
  source: NativeEvidenceSource = { engine: 'codex' }): Promise<NativeEvidence> {
  if (source.engine === 'grok') return collectGrokEvidence(runtimeHome, usageFile, source.requestsFile, agentId, executionId, expectedModel, previous);
  const [traces, usage, toolReceipts, modelContexts] = await Promise.all([
    readClosedTraces(runtimeHome, agentId), readUsage(usageFile, agentId, executionId, previous),
    readToolReceipts(runtimeHome, agentId), readModelContexts(runtimeHome),
  ]);
  if (traces.some(row => executionId !== undefined && row.turn_id !== executionId && !previous.includes(row.turn_id))) throw new Error('Foreign native execution trace');
  if (modelContexts.some(row => row.model !== expectedModel)) throw new Error('Native model differs from the declared model');
  return { traces: traces.filter(row => !previous.includes(row.turn_id)), usage, toolReceipts, modelContexts };
}

async function collectGrokEvidence(runtimeHome: string, usageFile: string, requestsFile: string, agentId: string,
  executionId: string | undefined, expectedModel: string, previous: readonly string[]): Promise<NativeEvidence> {
  const [traces, usage, requests, toolReceipts] = await Promise.all([
    readClosedTraces(runtimeHome, agentId), readGrokUsage(usageFile, agentId, executionId, expectedModel, previous),
    readGrokRequests(requestsFile, agentId, executionId, expectedModel, previous), readToolReceipts(runtimeHome, agentId, 'grok'),
  ]);
  if (traces.some(row => executionId !== undefined && row.turn_id !== executionId && !previous.includes(row.turn_id))) throw new Error('Foreign native execution trace');
  for (const row of usage) {
    const estimated = requests.filter(request => request.turn === row.turn && request.usage_source === 'estimated').length;
    if (estimated > (row.estimated_requests ?? 0)) throw new Error('Native Grok estimated request rows disagree with the usage row estimated_requests');
  }
  // Grok has no Codex session rollout: the broker-sealed usage row is its model identity.
  const modelContexts = usage.map(() => ({ model: expectedModel, approvalPolicy: null, sandboxPolicy: null }));
  return { traces: traces.filter(row => !previous.includes(row.turn_id)), usage, toolReceipts, modelContexts, requests };
}

/** Grok reports `grok-4.6` usage under its `-build` key; anything else is another model. */
const grokModel = (value: unknown, declared: string): string => {
  if (value !== declared && value !== `${declared}-build`) throw new Error('Native usage model differs from the declared model');
  return declared;
};
const tokens = (row: Record<string, unknown>, keys: readonly string[]): boolean => keys.every(key => Number.isSafeInteger(row[key]) && Number(row[key]) >= 0);
const turnKey = /^[a-f0-9]{64}$/u;
/** Plausibility bound for one broker turn's notional USD (Daimon caps a turn at 10M tokens); larger values are malformed, not spend. */
export const GROK_TURN_NOTIONAL_USD_MAX = 100;
export const plausibleNotionalUsd = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= GROK_TURN_NOTIONAL_USD_MAX;

/** Collapse byte-identical re-appends of one sealed key (Daimon replays); differing rows under one key are refused. */
function dedupe<T>(rows: readonly { key: string; row: T }[]): T[] {
  const seen = new Map<string, string>();
  return rows.flatMap(({ key, row }) => {
    const bytes = JSON.stringify(row);
    const prior = seen.get(key);
    if (prior === undefined) { seen.set(key, bytes); return [row]; }
    if (prior !== bytes) throw new Error('Conflicting native Grok ledger rows share one turn');
    return [];
  });
}

const belongs = (wake: unknown, executionId: string | undefined, previous: readonly string[]): boolean =>
  typeof wake === 'string' && (executionId === undefined || wake === executionId || previous.includes(wake));

async function readGrokUsage(file: string, agentId: string, executionId: string | undefined, expectedModel: string,
  previous: readonly string[]): Promise<NativeGrokUsage[]> {
  const rows = (await jsonLines(file)).map(value => {
    const row = object(value);
    if (row.v !== 'noopolis.daimon.turn-usage.v1' || row.agent !== agentId || row.engine !== 'grok' || !belongs(row.wake, executionId, previous) ||
        !timestamp(row.at) || typeof row.complete !== 'boolean' || typeof row.turn !== 'string' || !turnKey.test(row.turn) ||
        !tokens(row, ['input', 'output', 'cache_read', 'cache_write', 'total']) || !plausibleNotionalUsd(row.notional_usd) ||
        row.limit_reason !== undefined && !['tokens', 'requests', 'timeout', 'none'].includes(String(row.limit_reason)) ||
        row.estimated_requests !== undefined && (!Number.isSafeInteger(row.estimated_requests) || Number(row.estimated_requests) < 1)) {
      throw new Error('Native Grok usage schema or execution identity mismatch');
    }
    grokModel(row.model, expectedModel);
    if (Number(row.total) !== Number(row.input) + Number(row.cache_read) + Number(row.cache_write) + Number(row.output)) {
      throw new Error('Native Grok token totals are inconsistent');
    }
    return { key: row.turn, row: row as NativeGrokUsage };
  });
  const wakes = new Set<string>();
  return dedupe(rows).filter(row => {
    if (wakes.has(row.wake)) throw new Error('Duplicate native usage execution');
    wakes.add(row.wake);
    return !previous.includes(row.wake);
  });
}

async function readGrokRequests(file: string, agentId: string, executionId: string | undefined, expectedModel: string,
  previous: readonly string[]): Promise<NativeRequestUsage[]> {
  const rows = (await jsonLines(file)).map(value => {
    const row = object(value);
    if (row.v !== 'noopolis.daimon.turn-requests.v1' || row.agent !== agentId || row.engine !== 'grok' || !belongs(row.wake, executionId, previous) ||
        !timestamp(row.at) || typeof row.turn !== 'string' || !turnKey.test(row.turn) ||
        !tokens(row, ['request', 'requests', 'input', 'cached_input', 'fresh_input', 'cache_write', 'output', 'total']) ||
        row.usage_source !== undefined && !['stream', 'upstream', 'estimated'].includes(String(row.usage_source)) ||
        row.started_at !== undefined && !timestamp(row.started_at) || row.ended_at !== undefined && !timestamp(row.ended_at) ||
        timestamp(row.started_at) && timestamp(row.ended_at) && Date.parse(row.ended_at) < Date.parse(row.started_at)) {
      throw new Error('Native Grok request schema or execution identity mismatch');
    }
    grokModel(row.model, expectedModel);
    if (Number(row.input) !== Number(row.fresh_input) + Number(row.cached_input) ||
        Number(row.total) !== Number(row.input) + Number(row.cache_write) + Number(row.output)) throw new Error('Native Grok request totals are inconsistent');
    return { key: `${row.turn}:${String(row.request)}`, row: row as NativeRequestUsage };
  });
  return dedupe(rows).filter(row => !previous.includes(row.wake));
}

/**
 * The spend the broker sealed, read without a terminal frame to bind it to.
 *
 * The ordinary path binds every usage row to the closed execution the worker
 * reported. When the worker never answers, that binding does not exist and the
 * rows are still the only record of money already spent — the broker's proxy
 * metered every request and seals a failed turn's partial usage exactly as it
 * seals a completed one. So this reads the same ledger with the same strict
 * schema and the same dedupe-by-`turn`, and simply has no execution to filter
 * on; the per-slot ledger is wiped by every recycle, so its rows are this
 * trial's. It is never the path a scored trial takes.
 */
export async function readSealedGrokUsage(usageFile: string, agentId: string, expectedModel: string): Promise<NativeGrokUsage[]> {
  return readGrokUsage(usageFile, agentId, undefined, expectedModel, []);
}

export async function assertFreshNativeEvidence(runtimeHome: string, usageFile: string, agentId: string, expectedModel: string,
  source: NativeEvidenceSource = { engine: 'codex' }): Promise<void> {
  const evidence = await collectNativeEvidence(runtimeHome, usageFile, agentId, undefined, expectedModel, [], source);
  if (Object.values(evidence).some(rows => rows.length > 0)) throw new Error('A native trial requires fresh execution evidence');
}

export async function writeEvidence(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, file);
  const directory = await open(dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  const written = JSON.parse(await readFile(file, 'utf8')) as unknown;
  if (JSON.stringify(written) !== JSON.stringify(value)) throw new Error('Native evidence readback differs');
}

/**
 * The per-request rows the broker's proxy metered, read with no terminal frame
 * to bind them to.
 *
 * The sibling of `readSealedGrokUsage` over the second stream the broker writes
 * beside the usage ledger: one row per provider request, with the proxy's own
 * `started_at`/`ended_at`. It is the only record that can tell a request that
 * was issued and never answered (a row with a start and no end) from one that
 * was never issued at all (no row) — the distinction a turn killed by its
 * deadline cannot otherwise be diagnosed by. Same strict schema, same
 * dedupe-by-`turn:request`, and no execution to filter on.
 */
export async function readSealedGrokRequests(requestsFile: string, agentId: string, expectedModel: string): Promise<NativeRequestUsage[]> {
  return readGrokRequests(requestsFile, agentId, undefined, expectedModel, []);
}

const failureCodes = ['auth_stale', 'cancelled', 'engine_failed', 'invalid_request', 'limit_exceeded', 'turn_conflict', 'unavailable'];
const callName = /^(?:<invalid>|<truncated>|[A-Za-z0-9_.-]{1,64})$/u;
/** A bounded, non-empty, control-character-free string: the shape Daimon's protocol already admits. */
const controlFree = (value: unknown, maximum: number): boolean => {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maximum) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
};

/** Daimon's closed diagnostic, re-typed at this side's strictness; `reason` is already redacted and bounded there. */
function sealDiagnostic(value: unknown): NativeTurnSeal['diagnostic'] {
  const row = object(value);
  const fields = ['status', 'stage', 'failure_class', 'exit_code', 'term_signal'];
  const keys = Object.keys(row);
  if (keys.length !== fields.length + (row.reason === undefined ? 0 : 1) || fields.some(field => !Object.hasOwn(row, field))) throw new Error('Native Grok seal diagnostic schema mismatch');
  if (!fields.slice(0, 3).every(field => controlFree(row[field], 64)) || !tokens(row, ['exit_code', 'term_signal'])) throw new Error('Native Grok seal diagnostic schema mismatch');
  if (row.reason !== undefined && !controlFree(row.reason, 768)) throw new Error('Native Grok seal diagnostic schema mismatch');
  return row as NativeTurnSeal['diagnostic'];
}

/** Names, counts and elapsed milliseconds, internally consistent: never more answered than started. */
function sealMcp(value: unknown): NonNullable<NativeTurnSeal['mcp']> {
  const row = object(value);
  if (Object.keys(row).length !== 4 + (row.tunnels === undefined ? 0 : 1) || !tokens(row, ['started', 'answered', 'undecoded']) || !Array.isArray(row.outstanding) ||
      row.outstanding.length > 16 || Number(row.answered) > Number(row.started)) throw new Error('Native Grok seal MCP observation schema mismatch');
  const outstanding = row.outstanding.map(entry => {
    const call = object(entry);
    if (Object.keys(call).length !== 2 || typeof call.name !== 'string' || !callName.test(call.name) ||
        !tokens(call, ['outstanding_ms'])) throw new Error('Native Grok seal MCP observation schema mismatch');
    return { name: call.name, outstanding_ms: Number(call.outstanding_ms) };
  });
  if (outstanding.length > Number(row.started) - Number(row.answered)) throw new Error('Native Grok seal MCP observation schema mismatch');
  const tunnels = row.tunnels === undefined ? undefined : sealTunnels(row.tunnels);
  return { started: Number(row.started), answered: Number(row.answered), undecoded: Number(row.undecoded), outstanding, ...(tunnels === undefined ? {} : { tunnels }) };
}

/**
 * The session's GET SSE tunnels, at this side's strictness.
 *
 * A worker parked reading that stream wrote nothing anywhere until the broker
 * observed it, so this is the one member that tells "idle on an open tunnel"
 * from "idle having closed it" — and `delivered` tells a tunnel actively
 * carrying frames from one held open having received nothing. Counts and
 * elapsed milliseconds only, and internally consistent: nothing closes before
 * it opens, nothing delivers without opening, and no more is reported open
 * than `opened - closed`.
 */
function sealTunnels(value: unknown): NonNullable<NonNullable<NativeTurnSeal['mcp']>['tunnels']> {
  const row = object(value);
  if (Object.keys(row).length !== 4 || !tokens(row, ['opened', 'closed', 'delivered']) || !Array.isArray(row.open) ||
      row.open.length > 8 || Number(row.closed) > Number(row.opened) || Number(row.delivered) > Number(row.opened) ||
      row.open.length > Number(row.opened) - Number(row.closed)) throw new Error('Native Grok seal MCP tunnel schema mismatch');
  const open = row.open.map(entry => {
    const tunnel = object(entry);
    if (Object.keys(tunnel).length !== 2 || typeof tunnel.delivered !== 'boolean' ||
        !tokens(tunnel, ['open_ms'])) throw new Error('Native Grok seal MCP tunnel schema mismatch');
    return { open_ms: Number(tunnel.open_ms), delivered: tunnel.delivered };
  });
  return { opened: Number(row.opened), closed: Number(row.closed), delivered: Number(row.delivered), open };
}

/**
 * The sealed terminal record of a turn whose terminal response never travelled.
 *
 * The third stream the broker writes beside `usage.jsonl` and `requests.jsonl`.
 * It is the only route by which a *cancelled* turn's failure code, its worker's
 * redacted last words and the MCP tool call it was still blocked on reach this
 * side: the response those ride on is answered to a client that is already
 * gone, and the broker's own turn record sits in a `0700` store this uid cannot
 * read. Same strict schema, same dedupe-by-`turn`, no execution to filter on.
 *
 * Optional members are validated only when present and never defaulted: `mcp`
 * absent means the facade never observed the turn, which is not `started: 0`.
 */
export async function readSealedGrokTurnSeals(sealFile: string, agentId: string, expectedModel: string): Promise<NativeTurnSeal[]> {
  const rows = (await jsonLines(sealFile, 4 * 1024 * 1024)).map(value => {
    const row = object(value);
    if (row.v !== 'noopolis.daimon.turn-seal.v1' || row.agent !== agentId || row.engine !== 'grok' || typeof row.wake !== 'string' ||
        !timestamp(row.at) || typeof row.turn !== 'string' || !turnKey.test(row.turn) || !tokens(row, ['requests']) ||
        !['completed', 'failed'].includes(String(row.outcome)) ||
        !['tokens', 'requests', 'timeout', 'none'].includes(String(row.limit_reason)) ||
        (row.outcome === 'failed') !== (row.code !== undefined) ||
        row.code !== undefined && !failureCodes.includes(String(row.code))) throw new Error('Native Grok seal schema or execution identity mismatch');
    grokModel(row.model, expectedModel);
    if (row.diagnostic !== undefined) sealDiagnostic(row.diagnostic);
    if (row.mcp !== undefined) sealMcp(row.mcp);
    return { key: row.turn, row: row as NativeTurnSeal };
  });
  return dedupe(rows);
}
