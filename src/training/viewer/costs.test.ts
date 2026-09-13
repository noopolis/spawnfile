import { describe, expect, it } from 'vitest';
import { summarizeCosts, resolveCostAssumptions, type ModelPrice, type TrainingCostPlan } from '../src/experiments/costs/index.js';
import type { Usage } from '../src/contracts/index.js';
import { projectCosts } from './costs.js';
import { viewerFixture } from './fixture.js';
import { projectViewerData } from './projection.js';
import { renderViewer } from './page.js';

const usage: Usage = { inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 30,
  cacheWrite5mInputTokens: 30, cacheWrite1hInputTokens: 0, outputTokens: 10, reasoningTokens: 2, source: 'PRIVATE source' };
const price: ModelPrice = { model: 'judge-model', vendor: 'synthetic', currency: 'USD',
  perMillion: { input: 10, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20, output: 30 },
  source: 'https://example.org/prices', checkedAt: '2026-09-13', scope: 'PRIVATE price scope' };
function recorded(source = price.source) {
  return summarizeCosts([], { subjectModel: 'subject', prices: [{ ...price, source }], optimizerGenerations: [
    { model: 'judge-model', usage, route: 'subscription', outcome: 'invalid-response' },
    { model: null, usage: null, outcome: 'generation-error' },
  ] });
}
function plan(): TrainingCostPlan {
  return { schema: 'paideia.training-cost-plan.v1', modelCallsMade: 0,
    billing: 'API-equivalent valuation; subscription fees are not apportioned', coverage: 'estimated',
    budget: { maxTrials: 6, maxProposals: 1, metricCalls: 4, reservedTestTrials: 2 },
    datasetDigests: { train: 'PRIVATE train', test: 'SEALED digest' }, assumptions: resolveCostAssumptions(), warnings: ['PRIVATE warning'],
    apiEquivalentUsd: { low: 1, high: 2 }, pricedSubtotalUsd: { low: 1, high: 2 },
    lines: [{ role: 'judge', name: 'prose', phase: 'held-out', model: 'judge-model', provider: 'subscription', plannedCalls: 2,
      tokensPerCall: resolveCostAssumptions().judge, apiEquivalentUsd: { low: 1, high: 2 }, price }] };
}

describe('safe cost presentation', () => {
  it('projects only allowed accounting fields without raw warnings, usage sources, or sealed metadata', () => {
    const raw = recorded(); raw.warnings.push('PRIVATE judge reason');
    raw.entries[0]!.id = 'PRIVATE call'; raw.entries[0]!.trialId = 'SEALED trial';
    raw.entries[0]!.observedUsageReports = [{ location: 'PRIVATE artifact', usage: [usage] }];
    const costs = projectCosts(raw, plan())!;
    expect(JSON.stringify(costs)).not.toMatch(/PRIVATE|SEALED|observedUsageReports|datasetDigests|call/);
    expect(costs.observed).toMatchObject({ total: null, completeness: 'incomplete' });
    expect(costs.observed!.lines[0]).toMatchObject({ outcome: 'invalid-response', model: 'judge-model',
      usage: { inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 30, cacheWrite5mInputTokens: 30, cacheWrite1hInputTokens: 0 } });
    expect(costs.planned!.lines[0]).toMatchObject({ name: 'prose', provider: 'subscription' });
    expect(projectCosts()).toBeUndefined();
    expect(projectCosts(undefined, plan())!.observed).toBeUndefined();
    expect(projectCosts(raw)!.planned).toBeUndefined();
  });

  it.each(['javascript:alert(1)', 'https://user:password@example.org/prices', 'not-a-url'])(
    'does not turn untrusted rate sources into active links: %s', source => {
      expect(projectCosts(recorded(source))!.observed!.lines[0]!.price!.source).toBeNull();
    });

  it('marks malformed token evidence unknown without losing the rest of the display', () => {
    const raw = recorded(); raw.entries[0]!.usage = { ...usage, inputTokens: -1, cacheWrite5mInputTokens: undefined };
    raw.entries[0]!.valuation = { status: 'incomplete', apiEquivalentUsd: null, price: null, assumptions: ['PRIVATE error'] };
    const costs = projectCosts(raw)!;
    expect(costs.observed!.lines[0]!.usage).toMatchObject({ inputTokens: null, invalid: true, cachedInputTokens: 20, cacheWrite5mInputTokens: null });
    const fixture = viewerFixture(); fixture.costs = costs;
    expect(projectViewerData(fixture).costs).toEqual(costs);
    expect(renderViewer(fixture, 'nonce')).toContain('Invalid usage; incomplete / Unknown');
  });

  it('renders estimates separately from observed costs, escaped models and honest unknowns', () => {
    const raw = recorded(), attack = '<script>SECRET</script>"&';
    raw.entries[0]!.model = attack; raw.entries[0]!.name = attack; raw.entries[0]!.requestedModel = attack;
    raw.entries[0]!.providerId = 'named-provider';
    const fixture = viewerFixture(); fixture.costs = projectCosts(raw, plan());
    const page = renderViewer(projectViewerData(fixture), 'nonce');
    for (const text of ['API-equivalent estimate', '$1.000000–$2.000000', 'Recorded API-equivalent cost',
      'invalid-response', 'generation-error', 'Cache reads', 'Cache writes', 'Writes 5m / 1h', 'named-provider', 'checked 2026-09-13',
      'subscription quota percentages', 'Unknown', 'https://example.org/prices']) expect(page).toContain(text);
    expect(page).not.toContain(attack);
    expect(page).toContain('&lt;script&gt;SECRET&lt;/script&gt;&quot;&amp;');
    fixture.costs = projectCosts(undefined, plan());
    expect(renderViewer(fixture, 'n')).toContain('No recorded cost valuation supplied.');
    fixture.costs = projectCosts(recorded('not-a-url'));
    expect(renderViewer(fixture, 'n')).toContain('Source link unavailable');
    expect(renderViewer(fixture, 'n')).toContain('No preflight estimate supplied.');
    fixture.costs = projectCosts(summarizeCosts([], { subjectModel: 'unknown' }));
    expect(renderViewer(fixture, 'n')).toContain('No dated rate source supplied.');
  });

  it('bounds cost arrays, rejects unsafe links/ranges, and strips added raw evidence', () => {
    const fixture = viewerFixture(); fixture.costs = projectCosts(recorded(), plan());
    const raw = { ...fixture, costs: { ...fixture.costs, privateReport: 'SECRET' } };
    expect(JSON.stringify(projectViewerData(raw))).not.toContain('SECRET');
    Object.assign(fixture.costs!.observed!.lines[0]!, { modelBasis: 'invented-basis' });
    expect(() => projectViewerData(fixture)).toThrow();
    fixture.costs!.observed!.lines[0]!.modelBasis = 'provider-reported';
    fixture.costs!.observed!.lines[0]!.price!.source = 'javascript:alert(1)';
    expect(() => projectViewerData(fixture)).toThrow('HTTPS');
    fixture.costs!.observed!.lines[0]!.price!.source = price.source;
    fixture.costs!.planned!.total = { low: 2, high: 1 };
    expect(() => projectViewerData(fixture)).toThrow('Invalid cost range');
    fixture.costs!.planned!.total = null;
    fixture.costs!.observed!.lines = Array.from({ length: 1001 }, () => fixture.costs!.observed!.lines[0]!);
    expect(() => projectViewerData(fixture)).toThrow();
  });

  it('shows the requested optimizer model separately from unknown actual identity', () => {
    const fixture = viewerFixture();
    const raw = summarizeCosts([], { subjectModel: 'subject', prices: [price], optimizerGenerations: [
      { model: 'judge-model', modelBasis: 'requested-assumption', usage },
    ] });
    fixture.costs = projectCosts(raw);
    fixture.usage[0]!.modelBasis = 'requested-assumption';
    const projected = projectViewerData(fixture);
    expect(projected.costs!.observed!.lines[0]).toMatchObject({ model: null, requestedModel: 'judge-model',
      modelBasis: 'unknown', amount: null, valuationStatus: 'unpriced' });
    expect(projected.usage[0]!.modelBasis).toBe('requested-assumption');
    expect(renderViewer(projected, 'n')).toContain('requested-assumption');
    expect(renderViewer(projected, 'n')).toContain('Unknown / unknown');
  });
});
