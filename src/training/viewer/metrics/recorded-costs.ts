import type { ViewerCostRange, ViewerCostTokens, ViewerData, ViewerUsage } from '../types.js';
import type { RecordedCostGroup, TokenField, TokenSummary } from './types.js';

interface Entry {
  role: string;
  name: string;
  model: string | null;
  usage: ViewerCostTokens | ViewerUsage['usage'];
  amount: ViewerCostRange | null;
}

const fields: TokenField[] = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens',
  'cacheWrite5mInputTokens', 'cacheWrite1hInputTokens', 'outputTokens', 'reasoningTokens'];
const key = (value: { role: string; name: string }): string => JSON.stringify([value.role, value.name]);

function tokenSummary(entries: Entry[], field: TokenField, entryCount: number): TokenSummary {
  let knownEntries = 0;
  let sum = 0;
  for (const entry of entries) {
    const value = entry.usage?.[field];
    if (value === undefined || value === null || !Number.isSafeInteger(value) || value < 0) continue;
    knownEntries++;
    sum += value;
  }
  const knownSubtotal = Number.isSafeInteger(sum) ? sum : null;
  return { value: entryCount > 0 && knownEntries === entryCount ? knownSubtotal : null,
    knownSubtotal, knownEntries, entryCount };
}

function totalAmount(entries: Entry[]): { amount: ViewerCostRange | null; knownSubtotal: ViewerCostRange } {
  const known = entries.flatMap(entry => entry.amount === null ? [] : [entry.amount]);
  const knownSubtotal = known.reduce((sum, amount) => ({ low: sum.low + amount.low, high: sum.high + amount.high }),
    { low: 0, high: 0 });
  return { amount: entries.length > 0 && known.length === entries.length ? { ...knownSubtotal } : null, knownSubtotal };
}

/** Recorded API equivalents stay distinct from token coverage and subscription billing. */
export function summarizeRecordedCosts(data: ViewerData): RecordedCostGroup[] {
  const observed = data.costs?.observed;
  const entries: Entry[] = observed === undefined
    ? data.usage.map(usage => ({ role: usage.purpose, name: usage.purpose, model: usage.model,
      usage: usage.usage, amount: null }))
    : observed.lines.map(line => ({ role: line.role, name: line.name, model: line.model,
      usage: line.usage, amount: line.amount }));
  const grouped = new Map<string, Entry[]>();
  for (const entry of entries) {
    const values = grouped.get(key(entry)) ?? [];
    values.push(entry);
    grouped.set(key(entry), values);
  }
  const declared = new Map(observed?.groups.map(group => [key(group), group]));
  for (const id of declared.keys()) if (!grouped.has(id)) grouped.set(id, []);
  return [...grouped].map(([id, values]) => {
    const recorded = declared.get(id);
    const entryCount = Math.max(recorded?.entryCount ?? 0, values.length);
    const identity = recorded ?? values[0]!;
    const cost = observed === undefined ? { amount: null, knownSubtotal: null }
      : recorded === undefined ? totalAmount(values) : { amount: recorded.amount, knownSubtotal: recorded.knownSubtotal };
    return { role: identity.role, name: identity.name, source: observed === undefined ? 'usage' : 'valuation',
      models: [...new Set(values.flatMap(entry => entry.model === null ? [] : [entry.model]))],
      unknownModelEntries: entryCount - values.filter(entry => entry.model !== null).length,
      entryCount, amount: cost.amount === null ? null : { ...cost.amount },
      knownSubtotal: cost.knownSubtotal === null ? null : { ...cost.knownSubtotal },
      tokens: Object.fromEntries(fields.map(field => [field, tokenSummary(values, field, entryCount)])) as Record<TokenField, TokenSummary> };
  });
}
