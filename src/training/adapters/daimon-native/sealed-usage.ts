import { dirname, join } from 'node:path';
import type { Usage } from '../../contracts/execution.js';
import { aggregateUsage } from './observations.js';
import { isGrokLaunch, type NativeLaunch } from './receipt/index.js';
import { readSealedGrokUsage, readSealedGrokRequests, type NativeGrokUsage, type NativeRequestUsage } from './worker/index.js';

export interface SealedBrokerUsage { usage: Usage | null; rows: NativeGrokUsage[] }
export interface SealedBrokerUsageOptions { attempts?: number; intervalMs?: number }
const nothing: SealedBrokerUsage = { usage: null, rows: [] };
const pause = (milliseconds: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, milliseconds).unref?.(); });

/** The bounded wait both sealed reads share, or `null` for a bound that is not one. */
function schedule(options: SealedBrokerUsageOptions): { attempts: number; intervalMs: number } | null {
  const attempts = options.attempts ?? 20, intervalMs = options.intervalMs ?? 100;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || !Number.isSafeInteger(intervalMs) || intervalMs < 0) return null;
  return { attempts, intervalMs };
}

/**
 * What a brokered turn spent, when its terminal frame never arrived.
 *
 * A wake that fails spends the same money as one that publishes. The worker's
 * HTTP reply is the only route usage normally takes to this adapter, so a
 * worker that dies mid-turn used to report `usage: null` for a turn whose tool
 * calls had already succeeded — a fabricated zero, byte-identical to a measured
 * one, for spend that really happened. The broker is the single sealed usage
 * writer and it seals a failed turn's partial usage from what its own proxy
 * metered, so the record exists; in child-process execution this adapter shares
 * that filesystem and the launch receipt names the file.
 *
 * Three rules, all of them the ledger's own:
 *
 * - **Absence stays absence.** A missing, unreadable, malformed or empty ledger
 *   returns `null`, never `0`. Reading nothing is not the same as measuring
 *   nothing, and the difference is exactly what a fabricated zero destroys.
 * - **Dedupe by `turn`.** Daimon may append one sealed turn's identical bytes
 *   twice (a replay racing another replay), so every ledger consumer collapses
 *   them; `readSealedGrokUsage` does it and refuses rows that disagree under
 *   one key.
 * - **It cannot fail the trial.** This runs on a path that has already failed,
 *   and an instrumentation fault there would replace a diagnosable failure with
 *   a confusing one. Every fault is swallowed into `null`.
 *
 * The recovered spend is deliberately *not* promoted to complete coverage: the
 * execution it belongs to never closed, so nothing here can prove the ledger
 * holds all of it. It is `partial` — measured, bounded below, and honest about
 * being the broker's account rather than the turn's.
 *
 * The short poll exists because sealing is the broker's reaction to losing its
 * client: the worker dies, its control socket closes, and only then does the
 * broker seal and append. Reading once, immediately, would race that append and
 * report absence for a row written a moment later — which is the same
 * fabricated zero by a different route. The wait is bounded and always
 * terminates; giving up returns absence, not zero.
 */
export async function readSealedBrokerUsage(launch: NativeLaunch, options: SealedBrokerUsageOptions = {}): Promise<SealedBrokerUsage> {
  if (!isGrokLaunch(launch)) return nothing;
  const bound = schedule(options);
  if (!bound) return nothing;
  const { attempts, intervalMs } = bound;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await pause(intervalMs);
    try {
      const rows = await readSealedGrokUsage(launch.broker.usageLedgerPath, launch.agent.id, launch.agent.model);
      // A non-empty read is the answer, whatever it aggregates to: `aggregateUsage`
      // reports absence only for no rows at all, which is the case still waiting.
      if (rows.length) return { usage: aggregateUsage(rows), rows };
    } catch { return nothing; }
  }
  return nothing;
}

export const BROKER_REQUESTS_SCHEMA = 'paideia.daimon-native.broker-requests.v1';
/** Published rows per failed turn. A hung turn is read from its requests, not archived as a corpus. */
const publishedRows = 256;

/** One proxied request, as timings and counts. Never a body, a prompt, a reply or a credential. */
export interface BrokerRequestTiming {
  turn: string;
  request: number;
  requests: number;
  model: string;
  at: string;
  startedAt?: string;
  /** Absent exactly when the proxy never measured an end: the request that was issued and never answered. */
  endedAt?: string;
  /** Only when both ends were measured; an unanswered request has no duration to report. */
  durationMs?: number;
  usageSource?: NativeRequestUsage['usage_source'];
  input: number;
  cachedInput: number;
  freshInput: number;
  cacheWrite: number;
  output: number;
  total: number;
}

/** Why a present ledger could not be read, in a closed vocabulary: an error string could carry ledger bytes. */
export type BrokerRequestFailure = 'malformed' | 'schema' | 'unreadable';

export type BrokerRequestLedger =
  | { schema: typeof BROKER_REQUESTS_SCHEMA; outcome: 'read'; read: number; published: number; open: number; truncated: boolean; rows: BrokerRequestTiming[] }
  | { schema: typeof BROKER_REQUESTS_SCHEMA; outcome: 'unreadable'; failure: BrokerRequestFailure };

/** Issued, never answered. The single most important row in the file, and never filled in or dropped. */
const isOpen = (row: BrokerRequestTiming): boolean => row.startedAt !== undefined && row.endedAt === undefined;

/**
 * The published projection, built field by field.
 *
 * An allow-list, not a filter: the broker's schema permits unknown members, so
 * spreading a row would publish whatever it happened to carry. Every field here
 * is a timing, a count, or a value from a closed set (`model` is checked against
 * the declared model, `usage_source` against three literals), so nothing
 * free-form — no request body, no prompt, no bearer — has a route in.
 */
const timing = (row: NativeRequestUsage): BrokerRequestTiming => ({
  // `at` is the broker's own append clock, validated as a timestamp by the reader that produced this row.
  turn: row.turn, request: row.request, requests: row.requests, model: row.model, at: String(row.at),
  ...(row.started_at === undefined ? {} : { startedAt: row.started_at }),
  ...(row.ended_at === undefined ? {} : { endedAt: row.ended_at }),
  ...(row.started_at === undefined || row.ended_at === undefined ? {} : { durationMs: Date.parse(row.ended_at) - Date.parse(row.started_at) }),
  ...(row.usage_source === undefined ? {} : { usageSource: row.usage_source }),
  input: row.input, cachedInput: row.cached_input, freshInput: row.fresh_input,
  cacheWrite: row.cache_write, output: row.output, total: row.total,
});

/** Bound the published rows, keeping every unanswered one and then the most recent, in file order. */
function bounded(rows: readonly BrokerRequestTiming[]): BrokerRequestTiming[] {
  if (rows.length <= publishedRows) return [...rows];
  const kept = new Set<number>();
  for (let index = rows.length - 1; index >= 0 && kept.size < publishedRows; index--) if (isOpen(rows[index]!)) kept.add(index);
  for (let index = rows.length - 1; index >= 0 && kept.size < publishedRows; index--) kept.add(index);
  return rows.filter((_, index) => kept.has(index));
}

/**
 * A parse error can quote the bad line, so the fault publishes as a
 * classification rather than a message. `readPrivateFile`'s own guards are the
 * only I/O refusals that reach here; anything else is a row this reader refused.
 */
const classify = (error: unknown): BrokerRequestFailure =>
  error instanceof SyntaxError ? 'malformed' : error instanceof Error && !/native input/iu.test(error.message) ? 'schema' : 'unreadable';

/**
 * When a brokered turn last spoke to the provider, and whether it was answered.
 *
 * A turn killed by its deadline leaves two indistinguishable shapes in the
 * published event stream: a request was issued and never came back, or the
 * worker never issued the next request at all. Nothing on the adapter's side of
 * the wake can separate them — but the broker's proxy writes a second ledger
 * beside the usage one, a row per request with its own `started_at` and
 * `ended_at`, and there the first shape is a row with no end and the second is
 * no row. That file dies with the slot's tmpfs unless the failure path reads
 * it, so this reads it there and publishes it as an operator-only diagnostic.
 *
 * It keeps the rules of the ledger beside it:
 *
 * - **Absence stays absence.** A missing or empty ledger returns `undefined` —
 *   nothing is published. A fabricated empty list would read as "no requests
 *   were made", which is one of the two answers this change exists to
 *   distinguish. A ledger that is present but unreadable publishes a failure
 *   classification instead, which is neither answer.
 * - **An unanswered row survives as one.** `endedAt` is omitted, never filled,
 *   never normalised, and the bound keeps open rows before any other.
 * - **Timings and counts only**, through an allow-list projection.
 * - **It cannot fail the trial.** Every fault becomes a classification or
 *   absence, and the observer swallows a publish fault.
 *
 * The poll is the usage reader's, for the usage reader's reason: an unanswered
 * request has no row until the broker seals the turn it belongs to, so reading
 * once would race the append and report "never issued" for a request that was.
 */
export async function readSealedBrokerRequests(launch: NativeLaunch, options: SealedBrokerUsageOptions = {}): Promise<BrokerRequestLedger | undefined> {
  if (!isGrokLaunch(launch)) return undefined;
  const bound = schedule(options);
  if (!bound) return undefined;
  // The broker writes both streams into one slot ledger directory; every reader here derives the sibling the same way.
  const file = join(dirname(launch.broker.usageLedgerPath), 'requests.jsonl');
  for (let attempt = 0; attempt < bound.attempts; attempt++) {
    if (attempt > 0) await pause(bound.intervalMs);
    // The projection stays inside the same guard as the read: no fault of this
    // record's own may escape onto a path that has already failed.
    try {
      const rows = await readSealedGrokRequests(file, launch.agent.id, launch.agent.model);
      if (!rows.length) continue;
      const timings = rows.map(timing);
      const published = bounded(timings);
      return { schema: BROKER_REQUESTS_SCHEMA, outcome: 'read', read: timings.length, published: published.length,
        open: timings.filter(isOpen).length, truncated: published.length < timings.length, rows: published };
    } catch (error) { return { schema: BROKER_REQUESTS_SCHEMA, outcome: 'unreadable', failure: classify(error) }; }
  }
  return undefined;
}
