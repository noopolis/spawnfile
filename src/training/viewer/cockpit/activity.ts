import type { ViewerData } from '../types.js';
import { escapeHtml as e, percent } from './format.js';

export function liveActivity(data: ViewerData): string {
  const activity = data.activity;
  if (!activity) return '';
  return `<section class="panel"><h2 class="panel-title">Live measurements</h2><div class="panel-body">
<strong>${e(activity.status)}</strong><p class="muted">${e(activity.phase)} · ${e(activity.caseId)}</p>
<div class="budget-row"><span>Tools</span><strong>${activity.toolCalls}</strong></div>
<div class="budget-row"><span>Judge attempts</span><strong>${activity.judgeCalls}</strong></div>
<div class="activity-measurements">${activity.measurements.map(value =>
    `<div class="budget-row"><span title="${e(value.stageId)}">${e(value.criterionId)}${value.weight === undefined ? '' : ` · ${value.weight}×`}</span>
<strong>${value.kind === 'gate' ? e(value.status) : percent(value.score)}</strong></div>`).join('')}</div>
</div></section>`;
}
