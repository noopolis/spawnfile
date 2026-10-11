import { z } from 'zod';
import { grokModels } from '../../receipt/index.js';
import type { NativeTurnSeal } from '../types.js';
import { timestamp } from './io.js';

// Mirrors Daimon's validated terminal projection, including pre-instrumentation rows.
// The installed-writer contract test detects drift; product code never loads Daimon internals.
const count = z.number().int().nonnegative();
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const callName = z.string().regex(/^(?:<invalid>|<truncated>|[A-Za-z0-9_.-]{1,64})$/u);
const reason = z.string().min(1).refine(value => Buffer.byteLength(value, 'utf8') <= 768 &&
  [...value].every(character => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f));

const diagnostic = z.strictObject({
  status: z.enum(['prelaunch_failed', 'worker_failed', 'output_failed', 'cancelled']),
  stage: z.enum(['peer', 'request', 'registration', 'executable', 'exec', 'wait', 'output', 'attestation']),
  failure_class: z.enum(['peer', 'protocol', 'registration', 'executable', 'exec', 'wait', 'output_limit', 'cancelled', 'profile_missing', 'profile_invalid']),
  // The terminal protocol accepts signed safe integers here, unlike counters.
  exit_code: z.number().int(), term_signal: z.number().int(), reason: reason.optional(),
}).refine(row => {
  if (row.status === 'prelaunch_failed') {
    const stages: Record<string, string> = { peer: 'peer', request: 'protocol', registration: 'registration', executable: 'executable', exec: 'exec' };
    return row.reason === undefined && stages[row.stage] === row.failure_class;
  }
  if (row.status === 'worker_failed' && row.stage === 'attestation') {
    return row.reason === undefined && ['profile_missing', 'profile_invalid'].includes(row.failure_class);
  }
  if (row.status === 'worker_failed') return row.stage === 'wait' && ['exec', 'wait'].includes(row.failure_class);
  if (row.status === 'output_failed') return row.stage === 'output' && row.failure_class === 'output_limit';
  return row.stage === 'wait' && row.failure_class === 'cancelled';
});

const tunnels = z.strictObject({
  opened: count, closed: count, delivered: count,
  open: z.array(z.strictObject({ open_ms: count, delivered: z.boolean() })).max(8),
}).refine(row => row.closed <= row.opened && row.delivered <= row.opened && row.open.length <= row.opened - row.closed);

const mcp = z.strictObject({
  started: count, answered: count, undecoded: count,
  outstanding: z.array(z.strictObject({ name: callName, outstanding_ms: count })).max(16),
  refusals: z.strictObject({ route: count, expired: count, exhausted: count, unrouted: count, oversized: count }).optional(),
  tunnels: tunnels.optional(),
}).refine(row => row.answered <= row.started && row.outstanding.length <= row.started - row.answered);

const providerClock = z.strictObject({
  requests: count, linesRewritten: count, requestsWithoutDateLine: count, linesIgnored: count.optional(),
  injectedDate: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u).nullable(),
  taskDate: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u).nullable(),
}).refine(row => row.requestsWithoutDateLine <= row.requests &&
  (row.linesRewritten === 0 || row.requestsWithoutDateLine !== row.requests) &&
  [row.injectedDate, row.taskDate].every(date => row.linesRewritten === 0 ? date === null : date !== null));

const seal = z.strictObject({
  v: z.literal('noopolis.daimon.turn-seal.v1'), agent: identifier, wake: identifier, engine: z.literal('grok'),
  at: z.string().refine(timestamp), turn: identifier, outcome: z.enum(['completed', 'failed']),
  requests: count.max(1024), model: z.enum(grokModels), limit_reason: z.enum(['tokens', 'requests', 'timeout', 'none']),
  shell_clock: z.enum(['task', 'real', 'gap']).optional(), provider_clock: providerClock.optional(),
  code: z.enum(['auth_stale', 'cancelled', 'engine_failed', 'invalid_request', 'limit_exceeded', 'turn_conflict', 'unavailable']).optional(),
  diagnostic: diagnostic.optional(), mcp: mcp.optional(),
}).refine(row => row.outcome === 'completed'
  ? row.code === undefined && row.diagnostic === undefined && row.mcp === undefined && row.limit_reason === 'none'
  : row.code !== undefined && (row.code === 'limit_exceeded') === (row.limit_reason !== 'none'));

/** Unknown members at every level are refused, including protocol-only fields the seal writer omits. */
export function parseNativeTurnSeal(value: unknown, agentId: string, expectedModel: string): NativeTurnSeal {
  const parsed = seal.safeParse(value);
  if (!parsed.success || parsed.data.agent !== agentId || parsed.data.model !== expectedModel) {
    throw new Error('Native Grok seal schema or execution identity mismatch');
  }
  // Keep writer ordering for the ledger's byte-identical replay/conflict check.
  return value as NativeTurnSeal;
}
