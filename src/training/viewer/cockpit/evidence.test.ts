import { describe, expect, it } from 'vitest';
import { viewerFixture } from '../fixture.js';
import type { ViewerCosts } from '../types.js';
import { costView, provenance, trialDetails } from './evidence.js';

describe('collapsed recorded evidence', () => {
  it('keeps trials and event logs collapsed while retaining checks, events and observation coverage', () => {
    const data = viewerFixture();
    const html = trialDetails(data);
    expect(html).toContain('id="trial-0"');
    expect(html).toContain('Trial 01 · train');
    expect(html).toContain('Optimizer reward: score 0.5');
    expect(html).toContain('A known check');
    expect(html).toContain('Evidence: None supplied');
    expect(html).toContain('Evidence: event-1');
    expect(html).toContain('Evidence events · 1');
    expect(html).toContain('tool.complete');
    expect(html).toContain('Observation coverage');
    expect(html).toContain('<td>partial</td>');
    expect(html).not.toMatch(/<details[^>]*\bopen(?:[\s=>])/);
  });

  it('escapes all evidence strings and makes absent checks, events and scores explicit', () => {
    const data = viewerFixture(), hostile = `'"><script>attack()</script>&`;
    const trial = data.trials[0]!;
    trial.id = hostile; trial.caseId = hostile; trial.candidateId = hostile;
    trial.status = hostile; trial.score = null;
    trial.checks[0]!.id = hostile; trial.checks[0]!.label = hostile; trial.checks[0]!.evidenceIds = [hostile];
    trial.events[0] = { id: hostile, type: hostile, timestamp: hostile, summary: hostile };
    let html = trialDetails(data);
    expect(html).not.toContain('<script>attack');
    expect(html).toContain('&#39;&quot;&gt;&lt;script&gt;attack()&lt;/script&gt;&amp;');
    expect(html).toContain('score Unknown');
    expect(html).toContain('id="trial-0"');
    trial.checks = []; trial.events = []; trial.coverage = [];
    html = trialDetails(data);
    expect(html).toContain('No checks supplied.');
    expect(html).toContain('Evidence events · 0');
    expect(html).toContain('No entries supplied.');
    data.trials = [];
    expect(trialDetails(data)).toContain('No trials supplied.');
  });

  it('shows identities, parents and observed or requested model attribution without inference', () => {
    const data = viewerFixture();
    data.usage.push({ purpose: 'judge', model: 'requested', modelBasis: 'requested-assumption', route: null,
      usage: { inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningTokens: null, source: 'recorded' } });
    let html = provenance(data);
    expect(html).toContain('Selected candidate: proposal');
    expect(html).toContain('dspy.GEPA · 4/7 evaluations · 1/2 proposals');
    expect(html).toContain('<td>Baseline</td>');
    expect(html).toContain('<td>baseline</td>');
    expect(html).toContain('skills/review.md');
    expect(html).toContain('observed-model / provider-reported');
    expect(html).toContain('Unknown / unknown');
    expect(html).toContain('requested / requested-assumption');
    data.optimizer!.selectedCandidateId = undefined;
    expect(provenance(data)).toContain('Selected candidate: None supplied');
    data.optimizer = undefined; data.candidates = []; data.usage = [];
    html = provenance(data);
    expect(html).toContain('No optimizer progress supplied.');
    expect(html).toContain('No entries supplied.');
  });

  it('keeps planned, recorded and missing costs distinct with six-digit evidence amounts', () => {
    expect(costView(undefined)).toContain('No cost estimate or recorded valuation supplied.');
    const costs: ViewerCosts = { planned: { total: null, knownSubtotal: { low: 0, high: 0 }, coverage: 'partial', lines: [
      { role: 'judge', name: 'review', phase: 'train', model: 'requested', provider: null, plannedCalls: 2,
        amount: null, price: { source: null, checkedAt: '2026-09-14' } },
    ] } };
    let html = costView(costs);
    expect(html).toContain('API-equivalent estimate: <strong>Unknown</strong>');
    expect(html).toContain('known subtotal $0.000000');
    expect(html).toContain('Source link unavailable');
    expect(html).toContain('No recorded cost valuation supplied.');
    costs.planned!.total = { low: 1.125, high: 2.5 };
    costs.observed = { total: { low: 0, high: 0 }, knownSubtotal: { low: 0, high: 0 }, completeness: 'complete',
      usageCoverage: 'observed-only', groups: [], lines: [] };
    html = costView(costs);
    expect(html).toContain('$1.125000–$2.500000');
    expect(html).toContain('Recorded API-equivalent cost: <strong>$0.000000</strong>');
    expect(html).toContain('subscription quota percentages are separate and unknown');
    expect(html).not.toMatch(/<details[^>]*\bopen(?:[\s=>])/);
  });

  it('deduplicates source references and escapes source attributes after projection', () => {
    const source = { source: 'https://example.org/prices?a=1&b="quoted"', checkedAt: '<recorded>' };
    const costs: ViewerCosts = { planned: { total: null, knownSubtotal: { low: 0, high: 0 }, coverage: 'partial',
      lines: ['one', 'two'].map(name => ({ role: 'judge', name, phase: 'train', model: '<model>', provider: null,
        plannedCalls: 1, amount: null, price: source })) } };
    const html = costView(costs);
    expect(html.match(/>Rate source<\/a>/g)).toHaveLength(1);
    expect(html).toContain('href="https://example.org/prices?a=1&amp;b=&quot;quoted&quot;"');
    expect(html).toContain('checked &lt;recorded&gt;');
    expect(html).not.toContain('<model>');
    expect(costView({})).toContain('No dated rate source supplied.');
  });
});
