import { dirname, join } from 'node:path';
import type { Usage } from '../../contracts/execution.js';
import { aggregateUsage } from './observations.js';
import { isGrokLaunch, type NativeLaunch } from './receipt/index.js';
import { readSealedGrokUsage, readSealedGrokRequests, readSealedGrokTurnSeals, type NativeGrokUsage, type NativeRequestUsage, type NativeTurnSeal } from './worker/index.js';

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

export const BROKER_SEAL_SCHEMA = 'paideia.daimon-native.broker-seal.v1';

/** One outstanding MCP tool call: a name and how long it had been unanswered when the turn died. */
export interface BrokerSealOutstandingCall { name: string; outstandingMs: number }

/** One GET SSE tunnel still open when the turn died: its age, and whether the mount ever pushed through it. */
export interface BrokerSealOpenTunnel { openMs: number; delivered: boolean }
/**
 * The session's standalone GET tunnels. A worker parked reading one is idle in
 * exactly the way every other artifact renders as "doing nothing", so this is
 * what separates a turn that died with its tunnel open from one that closed it
 * first — and `delivered` separates a tunnel carrying frames from one held open
 * in silence.
 */
export interface BrokerSealTunnels { opened: number; closed: number; delivered: number; open: BrokerSealOpenTunnel[] }

/**
 * One sealed terminal turn, as an allow-list projection.
 *
 * Every member is a number, a name, a timing or a value from a closed set. The
 * one free-form string is `reason`, the worker's own last words, which Daimon
 * redacted with that turn's own capabilities as exact secrets and bounded
 * before it ever reached the ledger — the same discipline, and the same bytes,
 * as the startup diagnostic published beside it.
 */
export interface BrokerSealRecord {
  turn: string;
  wake: string;
  at: string;
  model: string;
  outcome: 'completed' | 'failed';
  requests: number;
  limitReason: 'tokens' | 'requests' | 'timeout' | 'none';
  shellClock?: NativeTurnSeal['shell_clock'];
  providerClock?: NativeTurnSeal['provider_clock'];
  code?: string;
  status?: string;
  stage?: string;
  failureClass?: string;
  exitCode?: number;
  termSignal?: number;
  reason?: string;
  /**
   * Present exactly when the broker's MCP facade observed this turn. Absent is
   * "never observed"; `started: 0` is "observed, and it called nothing". The
   * two are different answers and this record never collapses them.
   */
  mcp?: { started: number; answered: number; undecoded: number; outstanding: BrokerSealOutstandingCall[];
    refusals?: NonNullable<NativeTurnSeal['mcp']>['refusals']; tunnels?: BrokerSealTunnels };
}

export type BrokerSealLedger =
  | { schema: typeof BROKER_SEAL_SCHEMA; outcome: 'read'; read: number; outstanding: number; openTunnels: number; rows: BrokerSealRecord[] }
  | { schema: typeof BROKER_SEAL_SCHEMA; outcome: 'unreadable'; failure: BrokerRequestFailure };

/** Published seal rows per failed turn; a slot ledger is wiped per recycle, so this is a ceiling, not a window. */
const publishedSeals = 64;

const sealRecord = (row: NativeTurnSeal): BrokerSealRecord => ({
  turn: row.turn, wake: row.wake, at: String(row.at), model: row.model,
  outcome: row.outcome, requests: row.requests, limitReason: row.limit_reason,
  ...(row.shell_clock === undefined ? {} : { shellClock: row.shell_clock }),
  ...(row.provider_clock === undefined ? {} : { providerClock: {
    requests: row.provider_clock.requests, linesRewritten: row.provider_clock.linesRewritten,
    requestsWithoutDateLine: row.provider_clock.requestsWithoutDateLine,
    ...(row.provider_clock.linesIgnored === undefined ? {} : { linesIgnored: row.provider_clock.linesIgnored }),
    injectedDate: row.provider_clock.injectedDate, taskDate: row.provider_clock.taskDate,
  } }),
  ...(row.code === undefined ? {} : { code: row.code }),
  ...(row.diagnostic === undefined ? {} : {
    status: row.diagnostic.status, stage: row.diagnostic.stage, failureClass: row.diagnostic.failure_class,
    exitCode: row.diagnostic.exit_code, termSignal: row.diagnostic.term_signal,
    ...(row.diagnostic.reason === undefined ? {} : { reason: row.diagnostic.reason }),
  }),
  ...(row.mcp === undefined ? {} : {
    mcp: {
      started: row.mcp.started, answered: row.mcp.answered, undecoded: row.mcp.undecoded,
      outstanding: row.mcp.outstanding.map(call => ({ name: call.name, outstandingMs: call.outstanding_ms })),
      ...(row.mcp.refusals === undefined ? {} : { refusals: {
        route: row.mcp.refusals.route, expired: row.mcp.refusals.expired, exhausted: row.mcp.refusals.exhausted,
        unrouted: row.mcp.refusals.unrouted, oversized: row.mcp.refusals.oversized,
      } }),
      // Absent when the row predates the tunnel observation: not `opened: 0`.
      ...(row.mcp.tunnels === undefined ? {} : {
        tunnels: {
          opened: row.mcp.tunnels.opened, closed: row.mcp.tunnels.closed, delivered: row.mcp.tunnels.delivered,
          open: row.mcp.tunnels.open.map(tunnel => ({ openMs: tunnel.open_ms, delivered: tunnel.delivered })),
        },
      }),
    },
  }),
});

/**
 * What the broker sealed about a turn that never answered.
 *
 * A worker that CRASHES still produces a terminal HTTP reply, and its failure
 * code and last words ride that reply here. A worker that HANGS is killed by
 * the trial deadline, so there is no reply at all — and the sealed terminal
 * response, with the MCP call the worker was still blocked on riding on it,
 * is written only into the broker's own turn record, in a `0700` store this
 * uid cannot read, on a control root a training slot puts on tmpfs. Six live
 * runs ended exactly that way: usage recovered, `output: absent`, and no
 * account of what the turn was waiting for.
 *
 * The broker now projects that sealed response into a third stream beside the
 * two ledgers this module already recovers, and this reads it there, on the
 * same bounded poll and for the same reason: the seal is the broker's reaction
 * to losing its client, so reading once would race the append.
 *
 * Same rules as the requests ledger beside it. Absence stays absence — a
 * missing or empty stream publishes nothing, because a fabricated empty record
 * would read as "the turn sealed nothing", which is one of the answers this
 * exists to tell apart, and an `mcp` member is never invented for a turn the
 * facade did not observe. Numbers, names, timings, closed vocabularies and one
 * already-redacted reason. A fault publishes a classification, never a message
 * that could quote the bad line. And it cannot fail the trial: every fault
 * becomes a classification or absence.
 */
export async function readSealedBrokerSeal(launch: NativeLaunch, options: SealedBrokerUsageOptions = {}): Promise<BrokerSealLedger | undefined> {
  if (!isGrokLaunch(launch)) return undefined;
  const bound = schedule(options);
  if (!bound) return undefined;
  const file = join(dirname(launch.broker.usageLedgerPath), 'turns.jsonl');
  for (let attempt = 0; attempt < bound.attempts; attempt++) {
    if (attempt > 0) await pause(bound.intervalMs);
    try {
      const rows = await readSealedGrokTurnSeals(file, launch.agent.id, launch.agent.model);
      if (!rows.length) continue;
      const records = rows.slice(-publishedSeals).map(sealRecord);
      return { schema: BROKER_SEAL_SCHEMA, outcome: 'read', read: rows.length,
        outstanding: records.reduce((total, row) => total + (row.mcp?.outstanding.length ?? 0), 0),
        openTunnels: records.reduce((total, row) => total + (row.mcp?.tunnels?.open.length ?? 0), 0), rows: records };
    } catch (error) { return { schema: BROKER_SEAL_SCHEMA, outcome: 'unreadable', failure: classify(error) }; }
  }
  return undefined;
}
