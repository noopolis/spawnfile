import type { CockpitMetrics, MetricDefinition, MetricSplit, MetricSummary } from '../metrics/index.js';
import { escapeHtml as e, money, number, percent } from './format.js';

export function scoreAt(model: CockpitMetrics, candidateId: string, split: MetricSplit, metricId: string): MetricSummary | undefined {
  return model.scores.find(score => score.candidateId === candidateId && score.split === split && score.metricId === metricId);
}

/** Recorded development trial order, never deduplicated candidate means or sealed tests. */
export function convergence(model: CockpitMetrics, metric: MetricDefinition): string {
  const trials = model.trialMeasurements.filter(trial => trial.split === 'train' || trial.split === 'validation');
  if (trials.length === 0) return '<p class="empty-state">The first measured development trial will appear here.</p>';
  const x = (index: number) => 8 + index * 83 / Math.max(1, trials.length - 1);
  const y = (value: number) => 82 - value * 70;
  const grid = [0, 0.25, 0.5, 0.75, 1].map(value => `<line class="chart-gridline" x1="8%" x2="91%" y1="${y(value)}%" y2="${y(value)}%"/><text class="chart-tick" x="5%" y="${y(value)}%" dy="4" text-anchor="end">${value * 100}</text>`).join('');
  const candidateLabels = new Map(model.candidates.map(candidate => [candidate.id, candidate.label]));
  const series = (['train', 'validation'] as const).map(split => {
    let previous: { index: number; value: number } | undefined;
    return trials.map((trial, index) => {
      if (trial.split !== split) return '';
      const value = trial.values[metric.id];
      if (value == null) { previous = undefined; return ''; }
      const line = previous === undefined ? ''
        : `<line class="chart-${split}" x1="${x(previous.index)}%" y1="${y(previous.value)}%" x2="${x(index)}%" y2="${y(value)}%"/>`;
      previous = { index, value };
      const candidateLabel = candidateLabels.get(trial.candidateId) ?? 'Unmapped';
      const label = `Development trial ${index + 1}, ${trial.caseId}, ${candidateLabel} (${trial.candidateId}), ${split}: ${percent(value)} / 100`;
      const numberLabel = trials.length <= 12 ? `<text class="chart-tick chart-${split}" x="${x(index)}%" y="${y(value)}%" dy="${split === 'train' ? -12 : 18}" text-anchor="middle">${percent(value)}</text>` : '';
      return `${line}<circle class="chart-point chart-${split} ${split}" cx="${x(index)}%" cy="${y(value)}%" r="5" tabindex="0"><title>${e(label)}</title></circle>${numberLabel}`;
    }).join('');
  }).join('');
  const stride = Math.max(1, Math.ceil((trials.length - 1) / 7));
  const labels = trials.map((_, index) => index % stride === 0 || index === trials.length - 1
    ? `<text class="chart-tick" x="${x(index)}%" y="98%" text-anchor="${index === 0 ? 'start' : index === trials.length - 1 ? 'end' : 'middle'}">${index + 1}</text>` : '').join('');
  return `<svg class="chart-svg" role="img" aria-label="${e(metric.label)} by measured development trial ordinal: training and validation, 0 to 100">${grid}${series}${labels}</svg>`;
}

export function comparison(model: CockpitMetrics, metric: MetricDefinition): string {
  const latest = model.candidates.at(-1);
  if (!latest) return '<p class="empty-state">Awaiting a measured comparison.</p>';
  const paired = model.comparisons.find(row => row.candidateId === latest.id && row.split === 'validation' && row.metricId === metric.id);
  if (!paired || paired.matchedCases === 0) return '<p class="empty-state">No matched validation cases yet.</p>';
  return [
    { label: 'Baseline', value: paired.baselineValue, phase: 'baseline' },
    { label: latest.label, value: paired.candidateValue, phase: 'validation' },
  ].map(row => `<div class="score-row"><div class="score-name">${e(row.label)}</div><span class="score-number">${percent(row.value)}</span>
<svg class="score-track" viewBox="0 0 100 9" preserveAspectRatio="none" aria-hidden="true"><rect class="score-fill" data-phase="${row.phase}" width="${(row.value ?? 0) * 100}" height="9"/></svg></div>`).join('')
    + `<p class="chart-caption">${paired.matchedCases} matched case${paired.matchedCases === 1 ? '' : 's'} · same evidence</p>`;
}

export function costChart(model: CockpitMetrics): string {
  const total = model.costs.reduce((sum, row) => sum + (row.knownSubtotal?.low ?? 0), 0);
  if (model.costs.length === 0) return '<p class="empty-state">No recorded costs yet.</p>';
  let offset = 0;
  const segments = total > 0 ? model.costs.map(row => {
    const width = 100 * (row.knownSubtotal?.low ?? 0) / total;
    const segment = `<rect class="cost-segment" data-role="${e(row.role)}" x="${offset}" width="${width}" height="16"><title>${e(`${row.name}: ${money(row.knownSubtotal)}`)}</title></rect>`;
    offset += width; return segment;
  }).join('') : '';
  return `<svg class="cost-stack" viewBox="0 0 100 16" preserveAspectRatio="none" role="img" aria-label="Share of known cost lower bounds by role">${segments}</svg>
<div class="cost-legend">${model.costs.map(row => `<div><span class="legend-key" data-role="${e(row.role)}"></span><span>${e(row.role === row.name ? row.role : `${row.role} / ${row.name}`)}</span><strong>${money(row.knownSubtotal)}</strong><span class="muted">${number(row.entryCount)} calls</span></div>`).join('')}</div>
<p class="chart-caption">Known cost only · proportions use lower bounds</p>`;
}
