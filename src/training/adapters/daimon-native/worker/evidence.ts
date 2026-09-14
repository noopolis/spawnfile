import { lstat, readdir, readFile, rename, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readPrivateFile } from '../receipt/index.js';
import type { NativeEvidence, NativeTrace, NativeUsage } from './types.js';

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

async function readUsage(file: string, agentId: string, executionId?: string, previous: readonly string[] = []): Promise<NativeUsage[]> {
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
    return row as NativeUsage;
  }).filter(row => !previous.includes(row.wake));
}

/** Complete observed terminal usage requires one matching, closed native execution. */
export function nativeUsageCoverage(native: NativeEvidence, executionId?: string): 'complete' | 'partial' | 'absent' {
  if (!native.usage.length) return 'absent';
  const usage = native.usage[0]!;
  const trace = native.traces[0];
  return executionId !== undefined && native.usage.length === 1 && native.traces.length === 1
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

export async function readToolReceipts(runtimeHome: string, agentId: string): Promise<Record<string, unknown>[]> {
  const directory = join(runtimeHome, 'tool-state');
  const entries = (await files(directory)).filter(name => /^[a-f0-9]{64}\.json$/u.test(name));
  if (entries.length > 2048) throw new Error('Native tool receipt count exceeds its bound');
  return Promise.all(entries.sort().map(async name => {
    const row = object(JSON.parse(await readPrivateFile(join(directory, name), 65536)));
    if (row.agent_id !== agentId || row.engine !== 'codex' || !['mcp', 'moltnet'].includes(String(row.kind)) ||
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
  executionId: string | undefined, expectedModel: string, previous: readonly string[] = []): Promise<NativeEvidence> {
  const [traces, usage, toolReceipts, modelContexts] = await Promise.all([
    readClosedTraces(runtimeHome, agentId), readUsage(usageFile, agentId, executionId, previous),
    readToolReceipts(runtimeHome, agentId), readModelContexts(runtimeHome),
  ]);
  if (traces.some(row => executionId !== undefined && row.turn_id !== executionId && !previous.includes(row.turn_id))) throw new Error('Foreign native execution trace');
  if (modelContexts.some(row => row.model !== expectedModel)) throw new Error('Native model differs from the declared model');
  return { traces: traces.filter(row => !previous.includes(row.turn_id)), usage, toolReceipts, modelContexts };
}

export async function assertFreshNativeEvidence(runtimeHome: string, usageFile: string, agentId: string, expectedModel: string): Promise<void> {
  const evidence = await collectNativeEvidence(runtimeHome, usageFile, agentId, undefined, expectedModel);
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
