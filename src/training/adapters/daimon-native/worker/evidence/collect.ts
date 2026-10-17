import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { NativeCodexUsage, NativeEvidence, NativeEvidenceSource, NativeGrokUsage, NativeRequestUsage, NativeTrace, NativeTurnSeal } from '../types.js';
import { object, timestamp, jsonLines, files, readJson } from './io.js';
import { parseNativeTurnSeal } from './seal.js';

export async function readClosedTraces(runtimeHome: string, agentId: string, settleEmpty = false): Promise<NativeTrace[]> {
  return (await jsonLines(join(runtimeHome, 'telemetry', 'turns.ndjson'), 'closed trace telemetry', undefined, undefined, settleEmpty)).map(value => {
    const row = object(value);
    if (row.schema !== 'daimon.turn_trace.v1' || row.agent_id !== agentId || typeof row.turn_id !== 'string' ||
        !timestamp(row.started_at) || !timestamp(row.completed_at) || Date.parse(row.completed_at) < Date.parse(row.started_at) ||
        !['completed', 'failed'].includes(String(row.status)) || !Array.isArray(row.tools)) {
      throw new Error('Native trace schema, agent or terminal identity mismatch');
    }
    return row as NativeTrace;
  });
}

/**
 * Whether a row of this trial's evidence is the wake being collected for. One
 * rule for every stream, and it is attribution rather than arity: a bound wake
 * owns exactly what names its own execution, and the rest of this trial's
 * private home and ledger is another of its wakes. Unbound, only the trial's
 * other executions can be taken out.
 *
 * It used to refuse an unrecognised execution, which refused healthy runs:
 * Daimon revisits a trial's deferred deliveries when a new one arrives, so a
 * continued trial files executions belonging to no delivery this wake made.
 * Those are its history; only a foreign AGENT is an isolation fault, and every
 * reader here refuses one outright.
 */
const wakeOwns = (wake: string, executionId: string | undefined, others: readonly string[]): boolean =>
  executionId === undefined ? !others.includes(wake) : wake === executionId;

async function readUsage(file: string, agentId: string, settleEmpty: boolean): Promise<NativeCodexUsage[]> {
  const wakes = new Set<string>();
  return (await jsonLines(file, 'token usage ledger', undefined, undefined, settleEmpty)).map(value => {
    const row = object(value);
    if (row.v !== 'noopolis.daimon.turn-usage.v1' || row.agent !== agentId || row.engine !== 'codex' ||
        typeof row.wake !== 'string' || !timestamp(row.at) ||
        typeof row.complete !== 'boolean' || ['input', 'output', 'cache_read', 'total'].some(key =>
          !Number.isSafeInteger(row[key]) || Number(row[key]) < 0)) throw new Error('Native usage schema or execution identity mismatch');
    // This Codex contract reports one terminal total per execution, not deltas.
    if (wakes.has(row.wake)) throw new Error('Duplicate native usage execution');
    wakes.add(row.wake);
    if (Number(row.cache_read) > Number(row.input) || Number(row.total) !== Number(row.input) + Number(row.output)) {
      throw new Error('Native Codex token totals or cache subset are inconsistent');
    }
    return row as NativeCodexUsage;
  });
}

/**
 * Complete observed terminal usage requires one matching, closed native execution.
 *
 * The single trace and single usage row are this WAKE's, not this trial's: what
 * reaches here is already attributed to the bound execution, so a three-wake
 * trial still arrives with one of each per wake. The arity states that nothing
 * accounts for this execution twice, never how many wakes a trial may have.
 */
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

/** All execution totals in the fresh trial ledger, independently of wake attribution. */
function trialAccounting(native: NativeEvidence): NonNullable<NativeEvidence['accounting']> {
  const complete = native.traces.length === native.usage.length && native.usage.every(row =>
    nativeUsageCoverage({ ...native, usage: [row], traces: native.traces.filter(trace => trace.turn_id === row.wake),
      requests: native.requests?.filter(request => request.wake === row.wake) }, row.wake) === 'complete');
  return { usage: native.usage, coverage: !native.usage.length ? 'absent' : complete ? 'complete' : 'partial' };
}

export async function readToolReceipts(runtimeHome: string, agentId: string, engine: NativeEvidenceSource['engine'] = 'codex'): Promise<Record<string, unknown>[]> {
  const directory = join(runtimeHome, 'tool-state');
  const entries = (await files(directory)).filter(name => /^[a-f0-9]{64}\.json$/u.test(name));
  if (entries.length > 2048) throw new Error('Native tool receipt count exceeds its bound');
  return Promise.all(entries.sort().map(async name => {
    const row = object(await readJson(join(directory, name), 'tool receipt', 65536));
    if (row.agent_id !== agentId || row.engine !== engine || !['mcp', 'moltnet'].includes(String(row.kind)) ||
        typeof row.delivery_id !== 'string' || !timestamp(row.at)) throw new Error('Native tool receipt identity mismatch');
    if (row.kind === 'mcp' && (typeof row.server !== 'string' || typeof row.tool !== 'string' || typeof row.is_error !== 'boolean')) {
      throw new Error('Malformed native MCP receipt');
    }
    return row;
  }));
}

async function readModelContexts(runtimeHome: string, settleEmpty: boolean): Promise<NativeEvidence['modelContexts']> {
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
      for (const value of await jsonLines(file, 'Codex model context session', undefined, undefined, settleEmpty)) {
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

/**
 * One wake's own evidence, separated from the rest of its trial's by attribution.
 *
 * `others` is the trial's other executions as the RUNTIME named them, never a
 * count. Isolation is still refused where it can actually fail: a trace or row
 * that is not this agent's, and a model context that is not the declared model.
 * What is left is this trial's own work in a runtime home this worker asserted
 * empty before it started, so an execution beside this wake's is its history.
 */
export async function collectNativeEvidence(runtimeHome: string, usageFile: string, agentId: string,
  executionId: string | undefined, expectedModel: string, others: readonly string[] = [],
  source: NativeEvidenceSource = { engine: 'codex' }): Promise<NativeEvidence> {
  if (source.engine === 'grok') return collectGrokEvidence(runtimeHome, usageFile, source.requestsFile, agentId, executionId, expectedModel, others);
  const traces = await readClosedTraces(runtimeHome, agentId);
  const [usage, toolReceipts, modelContexts] = await Promise.all([
    readUsage(usageFile, agentId, traces.length > 0),
    readToolReceipts(runtimeHome, agentId), readModelContexts(runtimeHome, traces.length > 0),
  ]);
  if (modelContexts.some(row => row.model !== expectedModel)) throw new Error('Native model differs from the declared model');
  const accounting = trialAccounting({ traces, usage, toolReceipts, modelContexts });
  return { traces: traces.filter(row => wakeOwns(row.turn_id, executionId, others)),
    usage: usage.filter(row => wakeOwns(row.wake, executionId, others)), toolReceipts, modelContexts, accounting };
}

async function collectGrokEvidence(runtimeHome: string, usageFile: string, requestsFile: string, agentId: string,
  executionId: string | undefined, expectedModel: string, others: readonly string[]): Promise<NativeEvidence> {
  const traces = await readClosedTraces(runtimeHome, agentId);
  const [usage, requests, toolReceipts, seals] = await Promise.all([
    readGrokUsage(usageFile, agentId, undefined, expectedModel, [], traces.length > 0),
    readGrokRequests(requestsFile, agentId, undefined, expectedModel, []), readToolReceipts(runtimeHome, agentId, 'grok'),
    readSealedGrokTurnSeals(join(dirname(usageFile), 'turns.jsonl'), agentId, expectedModel),
  ]);
  for (const row of usage) {
    const estimated = requests.filter(request => request.turn === row.turn && request.usage_source === 'estimated').length;
    if (estimated > (row.estimated_requests ?? 0)) throw new Error('Native Grok estimated request rows disagree with the usage row estimated_requests');
  }
  // Grok has no Codex session rollout: the broker-sealed usage row is its model identity.
  const modelContexts = usage.map(() => ({ model: expectedModel, approvalPolicy: null, sandboxPolicy: null }));
  const accounting = trialAccounting({ traces, usage, toolReceipts, modelContexts, requests });
  const turnSeals = seals.filter(row => wakeOwns(row.wake, executionId, others));
  return { traces: traces.filter(row => wakeOwns(row.turn_id, executionId, others)),
    usage: usage.filter(row => wakeOwns(row.wake, executionId, others)), toolReceipts, modelContexts, accounting,
    requests: requests.filter(row => wakeOwns(row.wake, executionId, others)),
    ...(turnSeals.length ? { turnSeals } : {}) };
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

async function readGrokUsage(file: string, agentId: string, executionId: string | undefined, expectedModel: string,
  others: readonly string[], settleEmpty = false): Promise<NativeGrokUsage[]> {
  const rows = (await jsonLines(file, 'Grok usage ledger', undefined, undefined, settleEmpty)).map(value => {
    const row = object(value);
    if (row.v !== 'noopolis.daimon.turn-usage.v1' || row.agent !== agentId || row.engine !== 'grok' || typeof row.wake !== 'string' ||
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
    return wakeOwns(row.wake, executionId, others);
  });
}

async function readGrokRequests(file: string, agentId: string, executionId: string | undefined, expectedModel: string,
  others: readonly string[]): Promise<NativeRequestUsage[]> {
  const rows = (await jsonLines(file, 'Grok request ledger')).map(value => {
    const row = object(value);
    if (row.v !== 'noopolis.daimon.turn-requests.v1' || row.agent !== agentId || row.engine !== 'grok' || typeof row.wake !== 'string' ||
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
  return dedupe(rows).filter(row => wakeOwns(row.wake, executionId, others));
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
  if (evidence.traces.length || evidence.usage.length || evidence.toolReceipts.length || evidence.modelContexts.length || evidence.requests?.length || evidence.turnSeals?.length) throw new Error('A native trial requires fresh execution evidence');
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

/** Broker-sealed terminal observations; validate before attribution and deduplicate replays. */
export async function readSealedGrokTurnSeals(sealFile: string, agentId: string, expectedModel: string): Promise<NativeTurnSeal[]> {
  const rows = (await jsonLines(sealFile, 'Grok turn seal ledger', 4 * 1024 * 1024, 8192)).map(value => {
    const row = parseNativeTurnSeal(value, agentId, expectedModel);
    return { key: row.turn, row };
  });
  return dedupe(rows);
}
