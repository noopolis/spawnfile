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
export function projectCosts(costs?: CostReport, plan?: TrainingCostPlan): ViewerCosts | undefined {
  if (costs === undefined && plan === undefined) return undefined;
  return {
    ...(plan === undefined ? {} : { planned: { total: plan.apiEquivalentUsd, knownSubtotal: plan.pricedSubtotalUsd,
      coverage: plan.coverage, lines: plan.lines.map(line => ({ role: line.role, name: line.name, phase: line.phase,
        model: line.model, provider: line.provider ?? null, plannedCalls: line.plannedCalls,
        amount: line.apiEquivalentUsd, price: priceSource(line.price) })) } }),
    ...(costs === undefined ? {} : { observed: { total: costs.apiEquivalentUsd, knownSubtotal: costs.knownSubtotalUsd,
      completeness: costs.completeness, usageCoverage: costs.usageCoverage,
      groups: costs.groups.map(group => ({ role: group.role, name: group.name, entryCount: group.entryCount,
        amount: group.apiEquivalentUsd, knownSubtotal: group.knownSubtotalUsd })),
      lines: costs.entries.map(entry => ({ role: entry.role, name: entry.name, model: entry.model,
        requestedModel: entry.requestedModel ?? null, modelBasis: entry.modelBasis, provider: entry.providerId ?? null,
        route: entry.responseRoute ?? null, outcome: entry.outcome, usage: tokens(entry.usage),
        valuationStatus: entry.valuation.status, amount: entry.valuation.apiEquivalentUsd,
        price: priceSource(entry.valuation.price) })) } }),
  };
}
