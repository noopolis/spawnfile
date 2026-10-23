import type { Usage } from '../../contracts/execution.js';

export interface Range { low: number; high: number }
export interface TokenRates {
  input: number;
  cacheRead: number;
  output: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}
export interface ModelPrice {
  model: string;
  vendor: string;
  currency: 'USD';
  perMillion: TokenRates;
  source: string;
  checkedAt: string;
  scope: string;
  longContext?: { aboveInputTokens: number; inputMultiplier: number; outputMultiplier: number };
}
export interface CostValuation {
  status: 'priced' | 'range' | 'unpriced' | 'incomplete';
  apiEquivalentUsd: Range | null;
  price: ModelPrice | null;
  assumptions: string[];
}
export interface UsageCharge {
  role: 'subject' | 'judge' | 'optimizer' | 'embedding';
  name: string;
  model: string;
  billing: string;
  usage: Usage | null;
  /** A whole-run aggregate cannot establish per-session context pricing. */
  contextTier?: 'standard' | 'long' | 'unknown';
}
export interface TokenAssumption {
  inputTokens: Range;
  outputTokens: Range;
  cacheReadFraction: Range;
}
export interface CostAssumptions {
  subject: TokenAssumption;
  judge: TokenAssumption;
  optimizer: TokenAssumption;
  /** Named routes can override broad defaults. */
  judges?: Record<string, TokenAssumption>;
}
