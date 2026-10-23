import { describe, expect, it } from 'vitest';
import type { CockpitMetrics, MetricDefinition, MetricSummary, RecordedCostGroup } from '../metrics/index.js';
import { buildCockpitMetrics } from '../metrics/index.js';
import { viewerFixture } from '../fixture.js';
import { comparison, convergence, costChart, scoreAt } from './plots.js';

const metric: MetricDefinition = { id: 'strict', label: 'Recorded reward', kind: 'strict' };
function model(): CockpitMetrics {
  return { ...buildCockpitMetrics(viewerFixture()), metrics: [metric], scores: [], comparisons: [], costs: [] };
}
function score(candidateId: string, value: number | null, split: MetricSummary['split'] = 'train'): MetricSummary {
  return { candidateId, value, split, metricId: metric.id, observedCases: value === null ? 0 : 1,
    expectedCases: 2, observedTrials: value === null ? 0 : 1, trialCount: 1 };
}

describe('measured cockpit plots', () => {
  it('plots each measured trial even when candidate identity repeats', () => {
    const data = model();
    data.trialMeasurements = [
      { id: 't1', candidateId: 'baseline', caseId: 'case-a', split: 'train', values: { strict: 0 } },
      { id: 't2', candidateId: 'baseline', caseId: 'case-b', split: 'validation', values: { strict: 0.25 } },
      { id: 't3', candidateId: 'baseline', caseId: 'case-a', split: 'train', values: { strict: 1 } },
      { id: 't4', candidateId: 'baseline', caseId: 'case-b', split: 'validation', values: { strict: 0.75 } },
    ];
    const svg = convergence(data, metric);
    expect(svg.match(/<circle /g)).toHaveLength(4);
    expect(svg).toContain('class="chart-train" x1="8%" y1="82%" x2="63.333333333333336%" y2="12%"');
    expect(svg).toContain('class="chart-validation" x1="35.66666666666667%" y1="64.5%" x2="91%" y2="29.5%"');
    expect(svg).toContain('Development trial 3, case-a, Baseline (baseline), train: 100 / 100');
    data.scores = [score('proposal', 0.75, 'validation')];
    expect(scoreAt(data, 'proposal', 'validation', metric.id)?.value).toBe(0.75);
    expect(scoreAt(data, 'proposal', 'test', metric.id)).toBeUndefined();
    expect(scoreAt(data, 'proposal', 'train', 'missing')).toBeUndefined();
  });

  it('leaves absent/null selected metrics as gaps and excludes test/unknown trials', () => {
    const data = model();
    data.trialMeasurements = [null, 0.5, null, 1].map((value, index) => ({
      id: `t${index}`, caseId: 'case', candidateId: 'baseline', split: 'train', values: { strict: value },
    }));
    data.trialMeasurements[0]!.values = {};
    data.trialMeasurements.push({ id: 'sealed', caseId: 'SECRET', candidateId: 'SECRET', split: 'test', values: { strict: 0.9 } },
      { id: 'unmapped', caseId: 'UNKNOWN', candidateId: 'unknown', split: 'unknown', values: { strict: 0.9 } });
    const svg = convergence(data, metric);
    expect(svg.match(/<circle /g)).toHaveLength(2);
    expect(svg).not.toMatch(/<line class="chart-(?:train|validation)"/);
    expect(svg).not.toMatch(/SECRET|UNKNOWN|NaN/);
    expect(svg).toContain('Development trial 4');
    data.trialMeasurements = [];
    expect(convergence(data, metric)).toContain('first measured development trial');
  });

  it('places a single observation without fabricating a trend and escapes SVG labels', () => {
    const data = model(), hostile = '"><svg onload="alert(1)">&';
    data.candidates = [{ ...data.candidates[0]!, label: hostile }];
    const svg = convergence(data, { ...metric, label: hostile });
    expect(svg).toContain('cx="8%" cy="47%"');
    expect(svg).not.toContain('<svg onload');
    expect(svg).toContain('&quot;&gt;&lt;svg onload=&quot;alert(1)&quot;&gt;&amp;');
    expect(svg).not.toMatch(/<line class="chart-train"/);
    expect(svg).not.toMatch(/data-(?:candidate|metric)-id=/);
    data.candidates = [];
    expect(convergence(data, metric)).toContain('Unmapped');
  });

  it('bounds ordinal labels for dense histories while keeping every measured point', () => {
    const data = model();
    data.trialMeasurements = Array.from({ length: 20 }, (_, i) => ({ ...data.trialMeasurements[0]!, id: `t${i}` }));
    const svg = convergence(data, metric);
    expect(svg.match(/<circle /g)).toHaveLength(20);
    expect(svg.match(/<text /g)).toHaveLength(13);
    expect(svg).toContain('Development trial 20');
  });

  it('compares recorded paired values rather than unmatched summary scores', () => {
    const data = model();
    data.scores = [score('baseline', 0.99, 'validation'), score('proposal', 0.01, 'validation')];
    data.comparisons = [{ baselineId: 'baseline', candidateId: 'proposal', metricId: metric.id,
      split: 'validation', baselineValue: 0.25, candidateValue: 0.75, delta: 0.5, matchedCases: 1, expectedCases: 3 }];
    const html = comparison(data, metric);
    expect(html).toContain('data-phase="baseline" width="25"');
    expect(html).toContain('data-phase="validation" width="75"');
    expect(html).toContain('1 matched case · same evidence');
    expect(html).not.toContain('width="99"');
    data.comparisons[0]!.matchedCases = 2;
    expect(comparison(data, metric)).toContain('2 matched cases');
  });

  it('distinguishes absent comparisons, unmatched cases and unknown paired values', () => {
    const data = model();
    expect(comparison(data, metric)).toContain('No matched validation cases yet.');
    data.comparisons = [{ baselineId: 'baseline', candidateId: 'proposal', metricId: metric.id,
      split: 'validation', baselineValue: null, candidateValue: null, delta: null, matchedCases: 0, expectedCases: null }];
    expect(comparison(data, metric)).toContain('No matched validation cases yet.');
    data.comparisons[0]!.matchedCases = 1;
    const html = comparison(data, metric);
    expect(html.match(/class="score-number">—/g)).toHaveLength(2);
    expect(html.match(/width="0"/g)).toHaveLength(2);
    data.candidates = [];
    expect(comparison(data, metric)).toContain('Awaiting a measured comparison.');
  });

  it('plots known cost lower bounds by role and preserves unknown amounts', () => {
    const data = model();
    expect(costChart(data)).toContain('No recorded costs yet.');
    const tokens = buildCockpitMetrics(viewerFixture()).costs[0]!.tokens;
    const cost = (role: string, name: string, low: number | null): RecordedCostGroup => ({
      role, name, source: 'valuation', models: [], unknownModelEntries: 0, entryCount: 2,
      amount: null, knownSubtotal: low === null ? null : { low, high: low + 1 }, tokens,
    });
    data.costs = [cost('subject', 'subject', 3), cost('optimizer', '"><script>private</script>', 1), cost('judge', 'prose', null)];
    const html = costChart(data);
    expect(html).toContain('data-role="subject" x="0" width="75"');
    expect(html).toContain('data-role="optimizer" x="75" width="25"');
    expect(html).toContain('data-role="judge" x="100" width="0"');
    expect(html).toContain('<strong>—</strong>');
    expect(html).toContain('proportions use lower bounds');
    expect(html).not.toContain('<script>private');
    data.costs = [cost('judge', 'judge', 0), cost('subject', 'subject', null)];
    expect(costChart(data)).not.toContain('<rect');
    expect(costChart(data)).toContain('$0.00–1.00');
  });
});
