import type { ViewerData } from '../types.js';
import { buildCockpitMetrics, type CockpitMetrics } from '../metrics/index.js';
import { cockpitStyles } from './styles.js';
import { cockpitScript } from './interaction.js';
import { escapeHtml as e, shortId } from './format.js';
import { costView, provenance, trialDetails } from './evidence.js';
import { costOverview, metricOverview } from './overview.js';
import { liveActivity } from './activity.js';

function navigation(model: CockpitMetrics, data: ViewerData): string {
  return [['overview', 'Overview', '↗'], ['trials', 'Trials', String(data.trials.length)],
    ['costs', 'Costs & usage', 'USD'], ['provenance', 'Provenance', String(model.candidates.length)]].map(([view, label, count]) =>
    `<button class="nav-item${view === 'overview' ? ' active' : ''}" data-view-button="${view}" aria-pressed="${view === 'overview'}"><span>${label}</span><span class="nav-count">${count}</span></button>`).join('');
}

export function renderCockpit(data: ViewerData, nonce: string, metricIndex = 0): string {
  const model = buildCockpitMetrics(data);
  const activeIndex = model.metrics[metricIndex] === undefined ? 0 : metricIndex;
  const failed = data.experiment.status === 'failed';
  const replay = data.experiment.phase === 'replay' || ['completed', 'complete', 'failed'].includes(data.experiment.status);
  const badge = failed ? 'Run stopped' : data.experiment.status;
  const modelNames = [...new Set(data.costs?.observed?.lines.map(line => line.model ?? line.requestedModel).filter(Boolean) ?? [])];
  const phaseCounts = ['train', 'validation', 'test'].map(split => {
    const count = data.cases.filter(row => row.split === split).length;
    return `${split} ${split === 'test' && count === 0 ? '—' : count}`;
  }).join(' · ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(data.experiment.title)} · Paideia</title><style nonce="${e(nonce)}">${cockpitStyles}</style></head>
<body><div class="shell"><header class="topbar"><div class="brand"><span class="brand-mark" aria-hidden="true">◈</span> PAIDEIA <span class="top-title" title="${e(data.experiment.title)}">${e(data.experiment.title)}</span></div>
<div class="header-actions"><span class="badge ${failed ? 'bad' : 'good'}"><span class="dot"></span>${e(badge)}</span><button id="refresh" class="refresh-button">↻ Refresh</button><label><input id="poll" type="checkbox"${replay ? '' : ' checked'}> Live</label></div></header>
<div class="workspace"><aside class="sidebar"><section class="panel"><h2 class="panel-title">Experiment</h2><div class="panel-body"><p class="experiment-label">${e(data.experiment.title.split(' — ')[0]!)}</p><p class="muted">${e(data.optimizer?.name ?? 'Evaluation')}</p><p class="mono-id">run ${e(shortId(data.experiment.id))}</p></div><div class="panel-footer">${e(phaseCounts)}<br>Selected: ${e(model.candidates.find(candidate => candidate.selected)?.label ?? 'pending')}</div></section>
<nav class="panel" aria-label="Experiment views"><h2 class="panel-title">Console</h2><div class="panel-body">${navigation(model, data)}</div></nav>
<section class="panel budget-panel"><h2 class="panel-title">Budget</h2><div class="panel-body"><div class="budget-row"><span class="muted">Evaluations</span><strong>${data.optimizer ? `${data.optimizer.evaluations}/${data.optimizer.maxMetricCalls}` : '—'}</strong></div>
<div class="budget-row"><span class="muted">Proposals</span><strong>${data.optimizer ? `${data.optimizer.proposals}/${data.optimizer.maxProposals}` : '—'}</strong></div><p class="muted">${e(modelNames.join(' · ') || 'Model identity not supplied')}</p></div><div class="panel-footer">Local experiment · read only</div></section>${liveActivity(data)}</aside>
<main class="cockpit-main"><section class="view-pane" data-view-pane="overview" aria-label="Training overview">
${data.trials.length ? metricOverview(data, model, model.metrics[activeIndex]!, activeIndex) : '<section class="panel"><h2 class="panel-title">Trial trend</h2><div class="empty-state"><strong>No measured scores yet.</strong><span>Charts appear when the first trial is evaluated.</span></div></section>'}</section>
<section class="view-pane inspector" data-view-pane="trials" hidden><div class="overview-head"><div><p class="eyebrow">Drill down</p><h1 class="outcome-title">Trials & evidence</h1></div><span class="badge">${data.trials.length} trials</span></div>${trialDetails(data)}</section>
<section class="view-pane inspector" data-view-pane="costs" hidden><div class="overview-head"><div><p class="eyebrow">Recorded work</p><h1 class="outcome-title">Costs & usage</h1></div></div>${costOverview(data, model)}<details class="detail-drawer"><summary>Models, tokens & pricing evidence</summary><div class="panel-body">${costView(data.costs)}</div></details></section>
<section class="view-pane inspector" data-view-pane="provenance" hidden><div class="overview-head"><div><p class="eyebrow">Reproducibility</p><h1 class="outcome-title">Prompt provenance</h1></div></div><section class="panel"><h2 class="panel-title">Recorded identities</h2><div class="panel-body">${provenance(data)}</div></section></section>
</main></div><footer class="statusbar"><div class="status-group"><span>mode: <span class="status-value">${replay ? 'replay' : 'live'}</span></span><span id="stream-state">${replay ? 'Paused' : 'Connecting'}</span><span>source: <span class="status-value">recorded evidence</span></span></div><div class="status-group"><span>updated: <span class="status-value">${e(data.experiment.updatedAt)}</span></span><span class="${failed ? 'negative' : 'muted'}">${e(data.experiment.status)}</span></div></footer>
</div><script nonce="${e(nonce)}">${cockpitScript}</script></body></html>`;
}
