import type { Usage } from '../src/contracts/index.js';
import type { CostReport, ModelPrice, TrainingCostPlan } from '../src/experiments/costs/index.js';
import type { ViewerCosts, ViewerCostTokens, ViewerPriceSource } from './types.js';

function priceSource(price: ModelPrice | null): ViewerPriceSource | null {
  if (price === null) return null;
  let source: string | null = null;
  try {
    const url = new URL(price.source);
    if (url.protocol === 'https:' && !url.username && !url.password) source = url.href;
  } catch { /* Non-URL catalog sources remain unavailable as links. */ }
  return { checkedAt: price.checkedAt, source };
}

function tokens(usage: Usage | null): ViewerCostTokens | null {
  if (usage === null) return null;
  let invalid = false;
  const count = (value: number | null | undefined) => {
    if (value === undefined || value === null) return null;
    if (!Number.isSafeInteger(value) || value < 0) { invalid = true; return null; }
    return value;
  };
  const projected = { inputTokens: count(usage.inputTokens), cachedInputTokens: count(usage.cachedInputTokens),
    cacheWriteInputTokens: count(usage.cacheWriteInputTokens), cacheWrite5mInputTokens: count(usage.cacheWrite5mInputTokens),
    cacheWrite1hInputTokens: count(usage.cacheWrite1hInputTokens), outputTokens: count(usage.outputTokens),
    reasoningTokens: count(usage.reasoningTokens) };
  return { ...projected, invalid };
}

/** Explicit accounting fields only. Never expose raw warnings, call IDs, usage sources or legacy evidence. */
export function projectCosts(costs?: CostReport, plan?: TrainingCostPlan, hiddenTrials: ReadonlySet<string> = new Set()): ViewerCosts | undefined {
  if (costs === undefined && plan === undefined) return undefined;
  const entries = costs?.entries.map(entry => hiddenTrials.has(entry.trialId ?? '') ? { ...entry,
    name: entry.role, model: null, requestedModel: undefined, providerId: undefined, responseRoute: null,
    valuation: { ...entry.valuation, price: null } } : entry);
  const groups = hiddenTrials.size && entries ? anonymousGroups(entries) : costs?.groups;
  return {
    ...(plan === undefined ? {} : { planned: { total: plan.apiEquivalentUsd, knownSubtotal: plan.pricedSubtotalUsd,
      coverage: plan.coverage, lines: plan.lines.map(line => ({ role: line.role, name: line.name, phase: line.phase,
        model: line.model, provider: line.provider ?? null, plannedCalls: line.plannedCalls,
        amount: line.apiEquivalentUsd, price: priceSource(line.price) })) } }),
    ...(costs === undefined ? {} : { observed: { total: costs.apiEquivalentUsd, knownSubtotal: costs.knownSubtotalUsd,
      completeness: costs.completeness, usageCoverage: costs.usageCoverage,
      groups: groups!.map(group => ({ role: group.role, name: group.name, entryCount: group.entryCount,
        amount: group.apiEquivalentUsd, knownSubtotal: group.knownSubtotalUsd })),
      lines: entries!.map(entry => ({ role: entry.role, name: entry.name, model: entry.model,
        requestedModel: entry.requestedModel ?? null, modelBasis: entry.modelBasis, provider: entry.providerId ?? null,
        route: entry.responseRoute ?? null, outcome: entry.outcome, usage: tokens(entry.usage),
        valuationStatus: entry.valuation.status, amount: entry.valuation.apiEquivalentUsd,
        price: priceSource(entry.valuation.price) })) } }),
  };
}

/** Regroup projected accounting labels without exposing hidden case/model identities. */
function anonymousGroups(entries: CostReport['entries']): CostReport['groups'] {
  const groups = new Map<string, CostReport['groups'][number]>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.role, entry.name]);
    const group = groups.get(key) ?? { role: entry.role, name: entry.name, entryCount: 0, models: [],
      apiEquivalentUsd: { low: 0, high: 0 }, knownSubtotalUsd: { low: 0, high: 0 }, completeness: 'complete' };
    group.entryCount++;
    const amount = entry.valuation.apiEquivalentUsd;
    if (amount) {
      group.knownSubtotalUsd.low += amount.low; group.knownSubtotalUsd.high += amount.high;
      if (group.apiEquivalentUsd) { group.apiEquivalentUsd.low += amount.low; group.apiEquivalentUsd.high += amount.high; }
    } else { group.apiEquivalentUsd = null; group.completeness = 'incomplete'; }
    groups.set(key, group);
  }
  return [...groups.values()];
}
