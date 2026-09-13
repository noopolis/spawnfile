import type { ViewerData } from '../types.js';
import type { CockpitMetrics, MetricDefinition, MetricSplit } from '../metrics/index.js';
import { comparison, convergence, costChart, scoreAt } from './plots.js';
import { delta, escapeHtml as e, money, number, percent } from './format.js';

function metricCard(label: string, value: string, note: string, tone = ''): string {
  return `<div class="metric-card"><div class="metric-label">${e(label)}</div><div class="metric-value ${tone}">${e(value)}</div><div class="metric-note">${e(note)}</div></div>`;
}

function scoreCard(model: CockpitMetrics, metric: MetricDefinition, split: MetricSplit): string {
  const candidate = model.candidates.at(-1);
  const score = candidate === undefined ? undefined : scoreAt(model, candidate.id, split, metric.id);
  const paired = model.comparisons.find(row => row.candidateId === candidate?.id && row.split === split && row.metricId === metric.id);
  const change = paired?.delta ?? null;
  const pairedValue = change !== null;
  const note = pairedValue
    ? `${delta(change)} pts vs baseline · ${paired!.matchedCases}/${paired!.expectedCases ?? '?'} matched cases`
    : score === undefined ? 'No measured cases' : `No paired comparison · ${score.observedCases}/${score.expectedCases ?? '?'} observed cases`;
  return metricCard(`${split} · latest`, percent(pairedValue ? paired!.candidateValue : score?.value ?? null), note,
    change === null || change === 0 ? 'neutral' : change > 0 ? 'positive' : 'negative');
}

function trialMatrix(data: ViewerData, model: CockpitMetrics, metric: MetricDefinition): string {
  if (!data.trials.length) return '<p class="empty-state">Evaluated trials will appear here.</p>';
  const rows = data.trials.map((trial, index) => {
    const mapped = model.trialIndex[index]!;
    const candidate = model.candidates.find(row => row.id === mapped.candidateId);
    const split = mapped.split;
    const status = trial.status.split(' ')[0]!;
    const result = ['pass', 'fail'].includes(status) ? status : 'unknown';
    return `<tr><td><button class="trial-button" data-open-trial="${index}">${e(candidate?.label ?? 'Unmapped')} <span class="faint">↗</span></button></td>
<td class="case-label">${e(trial.caseId)}</td><td>${e(split)}</td><td><span class="status-cell ${result}">${e(status)}</span></td><td>${percent(trial.score)}</td></tr>`;
  }).join('');
  return `<div class="scroll"><table class="matrix-table"><thead><tr><th scope="col">Prompt</th><th scope="col">Case</th><th scope="col">Split</th><th scope="col">Required gates</th><th scope="col">Reward / 100</th></tr></thead><tbody>${rows}</tbody></table></div>
<div class="panel-footer">${e(metric.label)} is plotted above. A failed required gate gives optimizer reward 0. Select a trial to inspect it.</div>`;
}

export function metricOverview(data: ViewerData, model: CockpitMetrics, metric: MetricDefinition, index: number): string {
  const observed = data.costs?.observed;
  const note = observed?.total == null ? 'Known subtotal · total incomplete' : 'Recorded text-token valuation';
  const latest = model.candidates.at(-1);
  const developmentTrials = model.trialIndex.filter(trial => trial.split === 'train' || trial.split === 'validation').length;
  const val = model.comparisons.find(row => row.candidateId === latest?.id && row.metricId === metric.id && row.split === 'validation');
  const comparisonTitle = val?.delta == null ? 'Awaiting validation' : val.delta < 0 ? 'Validation went down' : val.delta > 0 ? 'Validation improved' : 'Validation unchanged';
  const kindLabel = metric.kind === 'strict' ? 'Optimizer reward · required gates applied' : metric.kind === 'stage' ? 'Raw stage score · before required gates' : 'Recorded check score';
  return `<div class="metric-view" data-metric-panel="${index}">
<div class="metric-grid">${scoreCard(model, metric, 'train')}${scoreCard(model, metric, 'validation')}
${metricCard('Development trials', number(developmentTrials), `${model.candidates.length} prompt versions observed`)}
${metricCard('API equivalent', money(observed?.total ?? observed?.knownSubtotal), note)}</div>
<div class="chart-grid">
<section class="panel convergence-panel"><h2 class="panel-title">Learning curve</h2><div class="panel-body">
<div class="chart-controls"><strong>${e(metric.label)} <span class="faint">/ 100</span></strong><label class="screen-reader-only" for="metric-${index}">Chart metric</label><select id="metric-${index}" class="chart-select" data-metric-select>${model.metrics.map((item, option) => `<option value="${option}"${index === option ? ' selected' : ''}>${e(item.label)}${item.kind === 'strict' ? ' · gated' : ''}</option>`).join('')}</select></div>
<div class="chart-legend"><span class="legend-key train">Training</span><span class="legend-key validation">Validation</span></div>
<div class="chart-wrap">${convergence(model, metric)}</div></div><p class="chart-caption">${kindLabel}. Observed cases only; gaps stay unmeasured.</p></section>
<section class="panel comparison-panel"><h2 class="panel-title">Generalization</h2><div class="panel-body"><p class="eyebrow">Same validation cases</p><h3 class="comparison-title">${comparisonTitle}</h3>${comparison(model, metric)}</div><p class="chart-caption">${model.candidates.length < 3 ? 'Too few prompt versions to establish convergence.' : 'Candidate history is measured progress, not proof of convergence.'}</p></section>
</div>
<section class="panel matrix-panel"><h2 class="panel-title">Trial results</h2><div class="matrix-body">${trialMatrix(data, model, metric)}</div></section>
</div>`;
}

export function costOverview(data: ViewerData, model: CockpitMetrics): string {
  const observed = data.costs?.observed;
  return `<div class="metric-grid">${metricCard('API equivalent', money(observed?.total ?? observed?.knownSubtotal), observed?.total == null ? 'Known subtotal; incomplete total' : 'Recorded valuation')}
${metricCard('Planned range', money(data.costs?.planned?.total), 'Dry-run assumptions')}
${metricCard('Recorded calls', number(model.costs.reduce((sum, row) => sum + row.entryCount, 0)), 'Subject + judges + optimizer')}
${metricCard('Subscription quota', '—', 'Not supplied by providers')}</div>
<section class="panel"><h2 class="panel-title">Where the work went</h2><div class="panel-body">${costChart(model)}</div></section>`;
}
