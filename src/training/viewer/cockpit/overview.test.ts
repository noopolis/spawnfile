import { describe, expect, it } from 'vitest';
import { viewerFixture } from '../fixture.js';
import { buildCockpitMetrics, type MetricDefinition } from '../metrics/index.js';
import { costOverview, metricOverview } from './overview.js';

const strict: MetricDefinition = { id: 'strict', label: 'Optimizer reward', kind: 'strict' };

describe('cockpit numeric overview', () => {
  it.each([
    [0.2, 'Validation improved', '+20 pts vs baseline', 'positive'],
    [-0.2, 'Validation went down', '−20 pts vs baseline', 'negative'],
    [0, 'Validation unchanged', '0 pts vs baseline', 'neutral'],
    [null, 'Awaiting validation', 'No paired comparison', 'neutral'],
  ] as const)('shows recorded validation delta %s without inferring improvement', (change, title, note, tone) => {
    const data = viewerFixture(), model = buildCockpitMetrics(data);
    model.scores = [{ candidateId: 'proposal', split: 'validation', metricId: 'strict', value: 0.6,
      observedCases: 2, expectedCases: 4, observedTrials: 3, trialCount: 3 }];
    model.comparisons = [{ baselineId: 'baseline', candidateId: 'proposal', metricId: 'strict', split: 'validation',
      delta: change, baselineValue: change === null ? null : 0.6 - change,
      candidateValue: 0.6, matchedCases: 2, expectedCases: 4 }];
    const html = metricOverview(data, model, strict, 0);
    expect(html).toContain(`<h3 class="comparison-title">${title}</h3>`);
    expect(html).toContain(`${note} · 2/4 ${change === null ? 'observed' : 'matched'} cases`);
    expect(html).toContain(`class="metric-value ${tone}">60`);
    expect(html).toContain('Too few prompt versions to establish convergence.');
    expect(html).toContain('Optimizer reward · required gates applied');
  });

  it('separates raw stage and recorded check scores from optimizer reward', () => {
    const data = viewerFixture(), model = buildCockpitMetrics(data);
    model.candidates.push({ id: 'third', sourceIds: [], label: 'Candidate 2', selected: false, splits: [] });
    const stage = model.metrics.find(metric => metric.kind === 'stage')!;
    const check = model.metrics.find(metric => metric.kind === 'check')!;
    const stageHtml = metricOverview(data, model, stage, 1);
    expect(stageHtml).toContain('data-metric-panel="1"');
    expect(stageHtml).toContain('Raw stage score · before required gates');
    expect(stageHtml).toContain('Candidate history is measured progress, not proof of convergence.');
    expect(stageHtml).toContain('No measured cases');
    expect(stageHtml).toContain('· gated</option>');
    expect(metricOverview(data, model, check, 2)).toContain('Recorded check score');
  });

  it('keeps the trial table compact with numeric drilldown keys and honest missing identities', () => {
    const data = viewerFixture(), hostile = '"><img onerror="attack">';
    data.trials = [
      { ...data.trials[0]!, candidateId: 'alias', status: 'pass complete', score: 1 },
      { ...data.trials[0]!, id: 'failed', status: 'fail required-gate', score: 0 },
      { ...data.trials[0]!, id: 'unmapped', candidateId: hostile, caseId: hostile, status: 'error stopped', score: null },
    ];
    data.candidates.push({ ...data.candidates[0]!, id: 'alias', nativeId: 'baseline' });
    const model = buildCockpitMetrics(data);
    const html = metricOverview(data, model, strict, 0);
    expect(html).toContain('data-open-trial="0">Baseline');
    expect(html).toContain('data-open-trial="2">Candidate 2');
    expect(html).toContain('class="status-cell pass">pass');
    expect(html).toContain('class="status-cell fail">fail');
    expect(html).toContain('class="status-cell unknown">error');
    expect(html).toContain('<td>unknown</td>');
    expect(html).toContain('<td>0</td>');
    expect(html).toContain('<td>—</td>');
    expect(html).not.toContain('<img');
    expect(html).not.toMatch(/data-(?:candidate|case|trial)-id=/);
  });

  it('renders no observations without fabricated values or convergence claims', () => {
    const data = viewerFixture();
    data.trials = []; data.candidates = [];
    const model = buildCockpitMetrics(data);
    const html = metricOverview(data, model, strict, 0);
    expect(html).toContain('Evaluated trials will appear here.');
    expect(html).toContain('No measured cases');
    expect(html).toContain('Awaiting a measured comparison.');
    expect(html).toContain('Known subtotal · total incomplete');
    expect(html).not.toContain('<circle');
  });

  it('counts only declared development trials, excluding released test and unmapped cases', () => {
    const data = viewerFixture(), trial = data.trials[0]!;
    data.cases.push({ id: 'released-test', split: 'test' },
      { id: 'conflict', split: 'train' }, { id: 'conflict', split: 'test' });
    data.trials.push({ ...trial, id: 'validation-trial', caseId: 'selection' },
      { ...trial, id: 'test-trial', caseId: 'released-test' },
      { ...trial, id: 'unknown-trial', caseId: 'not-declared' },
      { ...trial, id: 'conflicting-trial', caseId: 'conflict' });
    const html = metricOverview(data, buildCockpitMetrics(data), strict, 0);
    expect(html).toContain('Development trials</div><div class="metric-value ">2</div>');
    expect(html.match(/data-open-trial="\d+"/g)).toHaveLength(5);
    expect(html).toContain('<td>test</td>');
    expect(html).toContain('<td>unknown</td>');
  });

  it('uses the same matched cases for the headline score and baseline delta', () => {
    const data = viewerFixture(), trial = data.trials[0]!;
    data.cases.push({ id: 'extra', split: 'validation' });
    data.trials = [
      { ...trial, id: 'base', caseId: 'selection', score: 0.4 },
      { ...trial, id: 'paired', caseId: 'selection', candidateId: 'proposal', score: 0.6 },
      { ...trial, id: 'unpaired', caseId: 'extra', candidateId: 'proposal', score: 1 },
    ];
    const html = metricOverview(data, buildCockpitMetrics(data), strict, 0);
    expect(html).toContain('class="metric-value positive">60</div>');
    expect(html).toContain('+20 pts vs baseline · 1/2 matched cases');
    expect(html).not.toContain('class="metric-value positive">80</div>');
  });

  it('labels complete cost valuations, incomplete subtotals, and unknown quota separately', () => {
    const data = viewerFixture();
    data.costs = { observed: { total: { low: 3, high: 3 }, knownSubtotal: { low: 3, high: 3 },
      completeness: 'complete', usageCoverage: 'observed-only', groups: [], lines: [] },
    planned: { total: { low: 4, high: 6 }, knownSubtotal: { low: 4, high: 6 }, coverage: 'estimated', lines: [] } };
    let model = buildCockpitMetrics(data);
    expect(metricOverview(data, model, strict, 0)).toContain('Recorded text-token valuation');
    const complete = costOverview(data, model);
    expect(complete).toContain('$3.00');
    expect(complete).toContain('$4.00–6.00');
    expect(complete).toContain('Recorded valuation');
    expect(complete).toContain('Not supplied by providers');
    data.costs.observed!.total = null;
    expect(costOverview(data, model)).toContain('Known subtotal; incomplete total');
    data.costs = undefined;
    model = buildCockpitMetrics(data);
    const unknown = costOverview(data, model);
    expect(unknown).toContain('class="metric-value ">—');
    expect(unknown).toContain('class="metric-value ">2');
    expect(unknown).not.toContain('$0.00');
  });
});
