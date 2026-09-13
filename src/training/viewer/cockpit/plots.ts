import type { CockpitMetrics, MetricDefinition, MetricSplit, MetricSummary } from '../metrics/index.js';
import { escapeHtml as e, money, number, percent } from './format.js';

export function scoreAt(model: CockpitMetrics, candidateId: string, split: MetricSplit, metricId: string): MetricSummary | undefined {
  return model.scores.find(score => score.candidateId === candidateId && score.split === split && score.metricId === metricId);
}

/** Straight segments join adjacent observed candidates only; missing scores stay gaps. */
export function convergence(model: CockpitMetrics, metric: MetricDefinition): string {
  if (model.candidates.length === 0) return '<p class="empty-state">The first evaluated candidate will appear here.</p>';
  const x = (index: number) => 8 + index * 83 / Math.max(1, model.candidates.length - 1);
  const y = (value: number) => 82 - value * 70;
  const grid = [0, 0.25, 0.5, 0.75, 1].map(value => `<line class="chart-gridline" x1="8%" x2="91%" y1="${y(value)}%" y2="${y(value)}%"/><text class="chart-tick" x="5%" y="${y(value)}%" dy="4" text-anchor="end">${value * 100}</text>`).join('');
  const series = (['train', 'validation'] as const).map(split => {
    const values = model.candidates.map(candidate => scoreAt(model, candidate.id, split, metric.id));
    return values.map((score, index) => {
      if (score?.value == null) return '';
      const previous = values[index - 1];
      const line = index > 0 && previous?.value != null
        ? `<line class="chart-${split}" x1="${x(index - 1)}%" y1="${y(previous.value)}%" x2="${x(index)}%" y2="${y(score.value)}%"/>` : '';
      const label = `${model.candidates[index]!.label}, ${split}: ${percent(score.value)} / 100, ${score.observedCases} of ${score.expectedCases ?? '?'} cases`;
      return `${line}<circle class="chart-point chart-${split} ${split}" cx="${x(index)}%" cy="${y(score.value)}%" r="5" tabindex="0"><title>${e(label)}</title></circle>
<text class="chart-tick chart-${split}" x="${x(index)}%" y="${y(score.value)}%" dy="${split === 'train' ? -12 : 18}" text-anchor="middle">${percent(score.value)}</text>`;
    }).join('');
  }).join('');
  const labels = model.candidates.map((candidate, index) => `<text class="chart-tick" x="${x(index)}%" y="98%" text-anchor="${index === 0 ? 'start' : index === model.candidates.length - 1 ? 'end' : 'middle'}">${e(candidate.label)}</text>`).join('');
  return `<svg class="chart-svg" role="img" aria-label="${e(metric.label)} by candidate: training and validation, 0 to 100">${grid}${series}${labels}</svg>`;
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
