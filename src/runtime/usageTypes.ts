/** One parsed, validated line from the usage ledger. */
export interface UsageRecord {
  agent: string;
  at: string;
  cache_read: number;
  cache_write: number;
  calls: number;
  complete: boolean;
  engine: string;
  input: number;
  notional_usd: number;
  output: number;
  total: number;
  v: string;
  wake: string;
  /** Broker rows: the sha256 turn id every reader dedupes on (a replay may re-append a sealed row). */
  turn?: string;
  /** Broker rows: which per-turn limit ended the turn (`none` when none did). */
  limit_reason?: UsageLimitReason;
  /** Broker rows: the declared model the broker verified the turn ran. */
  model?: string;
  /** Broker rows: requests charged a conservative estimate because the provider response carried no valid usage. */
  estimated_requests?: number;
  outcome?: "completed" | "failed";
}

export const USAGE_LIMIT_REASONS = ["tokens", "requests", "timeout", "none"] as const;
export type UsageLimitReason = typeof USAGE_LIMIT_REASONS[number];
