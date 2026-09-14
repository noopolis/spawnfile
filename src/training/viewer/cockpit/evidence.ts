import type { ViewerCheck, ViewerCostRange, ViewerCosts, ViewerData } from '../types.js';
import { escapeHtml, shown, table } from './format.js';

function checkTree(checks: ViewerCheck[]): string {
  if (checks.length === 0) return '<p class="muted">No checks supplied.</p>';
  return `<ul>${checks.map((check) => `<li><strong>${escapeHtml(check.label)}</strong> — ${escapeHtml(check.status)};
score ${shown(check.score)}${check.weight === undefined ? '' : ` · weight ${shown(check.weight)} · contribution ${shown(check.weightedContribution ?? null)}`} <span class="muted">(${escapeHtml(check.id)})</span>
<p>Evidence: ${escapeHtml(check.evidenceIds.join(', ') || 'None supplied')}</p>
${check.children.length === 0 ? '' : checkTree(check.children)}</li>`).join('')}</ul>`;
}

function money(value: ViewerCostRange | null): string {
  if (value === null) return 'Unknown';
  return value.low === value.high ? `$${value.low.toFixed(6)}` : `$${value.low.toFixed(6)}–$${value.high.toFixed(6)}`;
}

export function costView(costs: ViewerCosts | undefined): string {
  if (costs === undefined) return '<p class="muted">No cost estimate or recorded valuation supplied.</p>';
  const { planned, observed } = costs;
  const sources = [...(planned?.lines ?? []), ...(observed?.lines ?? [])].flatMap(line => line.price === null ? [] : [line.price]);
  const references = [...new Map(sources.map(price => [JSON.stringify(price), price])).values()].map(price =>
    `<li>${price.source === null ? 'Source link unavailable' : `<a href="${escapeHtml(price.source)}" rel="noreferrer">Rate source</a>`} · checked ${escapeHtml(price.checkedAt)}</li>`).join('');
  const estimate = planned === undefined ? '<p class="muted">No preflight estimate supplied.</p>' :
    `<p>API-equivalent estimate: <strong>${money(planned.total)}</strong> · known subtotal ${money(planned.knownSubtotal)} · ${escapeHtml(planned.coverage)}</p>
<p class="muted">Planning assumptions, not a spending ceiling or an observed charge.</p>
${table(['Role / name', 'Phase', 'Requested model', 'Provider', 'Planned calls', 'Estimate USD'], planned.lines.map(line =>
      [`${line.role} / ${line.name}`, line.phase, line.model, shown(line.provider), String(line.plannedCalls), money(line.amount)]))}`;
  const recorded = observed === undefined ? '<p class="muted">No recorded cost valuation supplied.</p>' :
    `<p>Recorded API-equivalent cost: <strong>${money(observed.total)}</strong> · known subtotal ${money(observed.knownSubtotal)}</p>
<p>Observed-entry pricing: ${escapeHtml(observed.completeness)} · usage capture: ${escapeHtml(observed.usageCoverage)}.</p>
<p class="muted">Unknown or invalid usage is not zero. Recorded totals may omit unobserved work. Subject model attribution is an unverified requested-model assumption.</p>
${table(['Role / name', 'Recorded entries', 'API-equivalent USD', 'Known subtotal USD'], observed.groups.map(group =>
      [`${group.role} / ${group.name}`, String(group.entryCount), money(group.amount), money(group.knownSubtotal)]))}
<details><summary>Recorded models, outcomes and token counts</summary>
${table(['Role / name', 'Model / attribution', 'Requested model', 'Provider / route', 'Outcome', 'Input', 'Cache reads', 'Cache writes', 'Writes 5m / 1h', 'Output', 'Reasoning', 'Valuation / USD'], observed.lines.map(line =>
      [`${line.role} / ${line.name}`, `${shown(line.model)} / ${line.modelBasis}`, shown(line.requestedModel),
        `${shown(line.provider)} / ${shown(line.route)}`, line.outcome,
        shown(line.usage?.inputTokens ?? null), shown(line.usage?.cachedInputTokens ?? null), shown(line.usage?.cacheWriteInputTokens ?? null),
        `${shown(line.usage?.cacheWrite5mInputTokens ?? null)} / ${shown(line.usage?.cacheWrite1hInputTokens ?? null)}`,
        shown(line.usage?.outputTokens ?? null), shown(line.usage?.reasoningTokens ?? null),
        `${line.usage?.invalid ? 'Invalid usage; ' : ''}${line.valuationStatus} / ${money(line.amount)}`]))}</details>`;
  return `<p>USD text-token valuation only. Subscription fees and subscription quota percentages are separate and unknown.</p>
${estimate}${recorded}<p class="muted">Cache reads and cache writes are distinct subsets of input; reasoning is already included in output.</p>
${references ? `<ul>${references}</ul>` : '<p class="muted">No dated rate source supplied.</p>'}`;
}


export function trialDetails(data: ViewerData): string {
  if (data.trials.length === 0) return '<p class="empty-state">No trials supplied.</p>';
  return data.trials.map((trial, index) => `<details class="detail-drawer" id="trial-${index}" data-trial-key="${escapeHtml(trial.id)}"><summary>Trial ${String(index + 1).padStart(2, '0')} · ${escapeHtml(trial.caseId)} <span class="badge">${escapeHtml(trial.status.split(' ')[0]!)}</span></summary>
<div class="panel-body"><p class="mono-id">${escapeHtml(trial.id)} · candidate ${escapeHtml(trial.candidateId)}</p><p>Optimizer reward: score ${shown(trial.score)}</p>
<h3>Required checks</h3>${checkTree(trial.checks)}
<details><summary>Evidence events · ${trial.events.length}</summary>${table(['ID', 'Type', 'Timestamp', 'Summary'], trial.events.map(event => [event.id, event.type, event.timestamp, event.summary]))}</details>
<details><summary>Observation coverage</summary>${table(['Channel', 'Completeness', 'Ordering'], trial.coverage.map(row => [row.channel, row.completeness, row.ordering]))}</details>
</div></details>`).join('');
}

export function provenance(data: ViewerData): string {
  return `<p>Selected candidate: ${escapeHtml(data.optimizer?.selectedCandidateId ?? 'None supplied')}</p>
${data.optimizer === undefined ? '<p>No optimizer progress supplied.</p>' : `<p>${escapeHtml(data.optimizer.name)} · ${data.optimizer.evaluations}/${data.optimizer.maxMetricCalls} evaluations · ${data.optimizer.proposals}/${data.optimizer.maxProposals} proposals</p>`}
${table(['Candidate identity', 'Parents', 'Validation reward', 'Editable resources'], data.candidates.map(candidate => [candidate.id, candidate.parentIds.join(', ') || 'Baseline', shown(candidate.validationScore), candidate.editablePaths.join('\n')]))}
<h3>Recorded usage</h3>${table(['Purpose', 'Model / attribution', 'Route', 'Input', 'Cache reads', 'Output', 'Source'], data.usage.map(entry => [entry.purpose, `${shown(entry.model)} / ${entry.model === null ? 'unknown' : entry.modelBasis ?? 'provider-reported'}`, shown(entry.route), shown(entry.usage?.inputTokens ?? null), shown(entry.usage?.cachedInputTokens ?? null), shown(entry.usage?.outputTokens ?? null), entry.usage?.source ?? 'Unknown']))}`;
}
