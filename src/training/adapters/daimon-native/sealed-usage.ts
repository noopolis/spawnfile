import type { Usage } from '../../contracts/execution.js';
import { aggregateUsage } from './observations.js';
import { isGrokLaunch, type NativeLaunch } from './receipt/index.js';
import { readSealedGrokUsage, type NativeGrokUsage } from './worker/index.js';

export interface SealedBrokerUsage { usage: Usage | null; rows: NativeGrokUsage[] }
export interface SealedBrokerUsageOptions { attempts?: number; intervalMs?: number }
const nothing: SealedBrokerUsage = { usage: null, rows: [] };
const pause = (milliseconds: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, milliseconds).unref?.(); });

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
  const attempts = options.attempts ?? 20, intervalMs = options.intervalMs ?? 100;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || !Number.isSafeInteger(intervalMs) || intervalMs < 0) return nothing;
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
