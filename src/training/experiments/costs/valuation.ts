import type { Usage } from '../../contracts/execution.js';
import { standardPrices } from './catalog.js';
import type { CostValuation, ModelPrice, UsageCharge } from './types.js';

function count(value: number | null | undefined): value is number {
  if (value === null || value === undefined) return false;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Token counts must be nonnegative safe integers');
  return true;
}

/** API-equivalent valuation, independent of subscription billing. Never adds reasoning twice. */
export function valueUsage(charge: UsageCharge, catalog: readonly ModelPrice[] = standardPrices): CostValuation {
  const prices = catalog.filter(price => price.model === charge.model);
  if (prices.length > 1) throw new Error(`Ambiguous price for ${charge.model}`);
  const price = prices[0] ?? null;
  if (price === null) return { status: 'unpriced', apiEquivalentUsd: null, price, assumptions: [`No exact price for ${charge.model}.`] };
  for (const rate of Object.values(price.perMillion)) {
    if (!Number.isFinite(rate) || rate < 0) throw new Error('Token rates must be finite and nonnegative');
  }
  const usage = charge.usage;
  if (usage === null) return incomplete(price, 'Provider did not report usage.');
  for (const [key, value] of Object.entries(usage)) if (key !== 'source') count(value as number | null | undefined);
  if (!count(usage.inputTokens) || !count(usage.outputTokens)) return incomplete(price, 'Input or output token usage is missing.');
  const input = usage.inputTokens;
  const rates = price.perMillion;
  const notes = [price.scope, 'Reasoning tokens are included in output, never added again.'];
  const reads = usage.cachedInputTokens;
  const writes = usage.cacheWriteInputTokens;
  const knownReads = count(reads), knownWrites = count(writes);
  if (knownReads && reads > input) throw new Error('Cache reads exceed total input tokens');
  if (knownWrites && writes > input - (knownReads ? reads : 0)) throw new Error('Cache reads and writes exceed total input tokens');
  if (count(usage.reasoningTokens) && usage.reasoningTokens > usage.outputTokens) throw new Error('Reasoning tokens exceed total output tokens');
  const readLow = knownReads ? reads : 0;
  const readHigh = knownReads ? reads : input - (knownWrites ? writes : 0);
  if (!knownReads) notes.push('Cache-read count is unknown; price both cache-hit and uncached possibilities.');
  const supportsWrites = rates.cacheWrite5m !== undefined || rates.cacheWrite1h !== undefined;
  const writeHigh = knownWrites ? writes : supportsWrites ? input - readLow : 0;
  const writeLow = knownWrites ? writes : 0;
  if (supportsWrites && !knownWrites) notes.push('Cache-write count is unknown; include possible cache creation.');
  if (writeHigh > 0 && !supportsWrites) return incomplete(price, 'This rate catalog has no cache-write price.');
  const writeRates = [rates.cacheWrite5m, rates.cacheWrite1h].filter((rate): rate is number => rate !== undefined);
  // Standard catalogs discount reads and surcharge writes; validate before using corner extrema.
  if (rates.cacheRead > rates.input || writeRates.some(rate => rate < rates.input)) throw new Error('Catalog requires cache reads <= input <= cache writes');
  let writeCostLow = writeLow * Math.min(...writeRates);
  let writeCostHigh = writeHigh * Math.max(...writeRates);
  if (writeHigh === 0) { writeCostLow = 0; writeCostHigh = 0; }
  if (knownWrites) {
    const exact = exactWrites(usage, writes, price);
    if (exact === null) return incomplete(price, 'The observed cache-write duration has no price in this catalog.');
    if (exact !== undefined) { writeCostLow = exact; writeCostHigh = exact; }
    else if (writes > 0) {
      if (writeRates.length !== 2) return incomplete(price, 'Unknown cache-write duration requires both duration prices.');
      notes.push('Cache-write duration is unknown; range covers 5-minute and 1-hour pricing.');
    }
  } else if (writeHigh > 0 && writeRates.length !== 2) {
    return incomplete(price, 'Unknown cache creation requires both duration prices.');
  }
  let lowInput = (input - readHigh - writeLow) * rates.input + readHigh * rates.cacheRead + writeCostLow;
  let highInput = (input - readLow - writeHigh) * rates.input + readLow * rates.cacheRead + writeCostHigh;
  let lowOutput = usage.outputTokens * rates.output, highOutput = lowOutput;
  if (price.longContext !== undefined) {
    const tier = charge.contextTier ?? 'unknown';
    const { inputMultiplier, outputMultiplier } = price.longContext;
    if (![inputMultiplier, outputMultiplier].every(value => Number.isFinite(value) && value >= 1)) throw new Error('Invalid context multiplier');
    if (tier === 'long') { lowInput *= inputMultiplier; lowOutput *= outputMultiplier; }
    if (tier !== 'standard') { highInput *= inputMultiplier; highOutput *= outputMultiplier; }
    if (tier === 'unknown') notes.push('Session context tier is unknown; range includes the long-context uplift.');
  }
  const low = (lowInput + lowOutput) / 1_000_000, high = (highInput + highOutput) / 1_000_000;
  if (!Number.isFinite(low) || !Number.isFinite(high)) throw new Error('Cost calculation overflow');
  return { status: low === high ? 'priced' : 'range', apiEquivalentUsd: { low, high }, price, assumptions: notes };
}

function exactWrites(usage: Usage, total: number, price: ModelPrice): number | null | undefined {
  const short = usage.cacheWrite5mInputTokens, long = usage.cacheWrite1hInputTokens;
  if (!count(short) || !count(long)) return undefined;
  if (short + long !== total) throw new Error('Cache-write duration counts do not match total writes');
  const a = price.perMillion.cacheWrite5m, b = price.perMillion.cacheWrite1h;
  if ((short > 0 && a === undefined) || (long > 0 && b === undefined)) return null;
  return short * (a ?? 0) + long * (b ?? 0);
}

function incomplete(price: ModelPrice, reason: string): CostValuation {
  return { status: 'incomplete', apiEquivalentUsd: null, price, assumptions: [reason] };
}
