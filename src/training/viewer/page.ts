import type { ViewerCheck, ViewerCostRange, ViewerCosts, ViewerData } from './types.js';

export const viewerStyles = `
:root{color-scheme:light dark;font:16px/1.5 system-ui,sans-serif;background:#f5f3ed;color:#202b31}
*{box-sizing:border-box}body{margin:0}main{max-width:1200px;margin:auto;padding:2rem}
header{border-bottom:3px solid #16756c;padding-bottom:1rem}h1{font-size:2rem;line-height:1.2}h2{margin-top:2rem}
a{color:#08665e}nav{display:flex;gap:1rem;flex-wrap:wrap}section,details{scroll-margin-top:1rem}
.panel{background:#fff;border:1px solid #c4c9c5;border-radius:.5rem;padding:1rem;margin:1rem 0}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #d8ddd9;padding:.55rem;white-space:pre-wrap;overflow-wrap:anywhere}
th{font-weight:650}p{overflow-wrap:anywhere}code{font-size:.85em}summary{cursor:pointer;font-weight:650}
li{margin:.5rem 0}svg{display:block;min-width:460px;width:100%;max-height:420px}svg text{fill:currentColor;font:14px system-ui}svg rect{fill:#e3f3ed;stroke:#16756c}svg line{stroke:#647873;stroke-width:2}
.muted{color:#52615d}.controls{display:flex;gap:1rem;align-items:center;margin-top:1rem}button{font:inherit;padding:.3rem .7rem}
@media(prefers-color-scheme:dark){:root{background:#13221f;color:#e5eee7}.panel{background:#192d28;border-color:#4b645a}a{color:#81d8c5}.muted{color:#bacac3}th,td{border-color:#40564c}svg rect{fill:#24483c;stroke:#81d8c5}}
@media(max-width:600px){main{padding:1rem}h1{font-size:1.6rem}}
`;

export const viewerScript = `
document.getElementById('refresh').addEventListener('click',()=>location.reload());
setInterval(()=>{if(document.getElementById('poll').checked)location.reload();},5000);
`;

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#39;' })[character]!);
}

function shown(value: string | number | null): string { return value === null ? 'Unknown' : String(value); }

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '<p class="muted">No entries supplied.</p>';
  return `<div class="scroll"><table><thead><tr>${headers.map((value) => `<th scope="col">${escapeHtml(value)}</th>`).join('')}</tr></thead>
<tbody>${rows.map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function checkTree(checks: ViewerCheck[]): string {
  if (checks.length === 0) return '<p class="muted">No checks supplied.</p>';
  return `<ul>${checks.map((check) => `<li><strong>${escapeHtml(check.label)}</strong> — ${escapeHtml(check.status)};
score ${shown(check.score)} <span class="muted">(${escapeHtml(check.id)})</span>
<p>Evidence: ${escapeHtml(check.evidenceIds.join(', ') || 'None supplied')}</p>
${check.children.length === 0 ? '' : checkTree(check.children)}</li>`).join('')}</ul>`;
}

function lineage(data: ViewerData): string {
  if (data.candidates.length === 0) return '';
  const positions = new Map(data.candidates.map((candidate, index) => [candidate.id, index]));
  const rows = data.candidates.map((candidate, index) => {
    const links = candidate.parentIds.map((parent) => {
      const source = positions.get(parent);
      return source === undefined ? '' : `<line x1="80" y1="${source * 70 + 40}" x2="80" y2="${index * 70 + 20}"/>`;
    }).join('');
    return `${links}<rect x="30" y="${index * 70 + 20}" width="100" height="24" rx="5"/>
<text x="145" y="${index * 70 + 38}">${escapeHtml(candidate.id)} · validation ${shown(candidate.validationScore)}</text>`;
  }).join('');
  return `<div class="scroll"><svg role="img" aria-label="Candidate parent relationships; full values in the following table" viewBox="0 0 1000 ${data.candidates.length * 70 + 20}">${rows}</svg></div>`;
}

function money(value: ViewerCostRange | null): string {
  if (value === null) return 'Unknown';
  return value.low === value.high ? `$${value.low.toFixed(6)}` : `$${value.low.toFixed(6)}–$${value.high.toFixed(6)}`;
}

function costView(costs: ViewerCosts | undefined): string {
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

/** Only schema-validated presentation data reaches this renderer. */
export function renderViewer(data: ViewerData, nonce: string): string {
  const { experiment, optimizer } = data;
  const usage = data.usage.map((entry) => [entry.purpose, shown(entry.model),
    entry.model === null ? 'unknown' : entry.modelBasis ?? 'provider-reported', shown(entry.route),
    shown(entry.usage?.inputTokens ?? null), shown(entry.usage?.cachedInputTokens ?? null),
    shown(entry.usage?.cacheWriteInputTokens ?? null),
    shown(entry.usage?.outputTokens ?? null), shown(entry.usage?.reasoningTokens ?? null), entry.usage?.source ?? 'Unknown']);
  const trials = data.trials.map((trial) => `<details class="panel" open><summary>${escapeHtml(trial.id)} — ${escapeHtml(trial.status)}; score ${shown(trial.score)}</summary>
<p>Case ${escapeHtml(trial.caseId)} · candidate ${escapeHtml(trial.candidateId)}</p>
<h3>Observation coverage</h3>${table(['Channel', 'Completeness', 'Ordering'], trial.coverage.map((coverage) => [coverage.channel, coverage.completeness, coverage.ordering]))}
<h3>Check tree</h3>${checkTree(trial.checks)}
<h3>Evidence events</h3>${table(['ID', 'Type', 'Timestamp', 'Summary'], trial.events.map((event) => [event.id, event.type, event.timestamp, event.summary]))}</details>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(experiment.title)} · Paideia</title><style nonce="${escapeHtml(nonce)}">${viewerStyles}</style></head>
<body><main><header><p>PAIDEIA · LOCAL EXPERIMENT VIEWER</p><h1>${escapeHtml(experiment.title)}</h1>
<p>${escapeHtml(experiment.id)} · ${escapeHtml(experiment.phase)} · <strong>${escapeHtml(experiment.status)}</strong></p>
<p class="muted">Snapshot updated ${escapeHtml(experiment.updatedAt)}. Missing observations and usage remain unknown.</p>
<nav aria-label="Experiment sections"><a href="#cases">Cases</a><a href="#trials">Trials and evidence</a><a href="#candidates">Candidates</a><a href="#costs">Costs</a><a href="#usage">Usage</a></nav>
<div class="controls"><button id="refresh" type="button">Refresh snapshot</button><label><input id="poll" type="checkbox" checked> Refresh every 5 seconds</label></div>
<p class="muted">Refresh reads the supplied saved-data projection only.</p></header>
<section id="cases"><h2>Cases</h2>${table(['Case', 'Split', 'Label'], data.cases.map((record) => [record.id, record.split, record.label ?? '']))}</section>
<section id="trials"><h2>Trials and evidence</h2>${trials || '<p class="muted">No trials supplied.</p>'}</section>
<section id="candidates"><h2>Candidate lineage</h2>${optimizer === undefined ? '<p class="muted">No optimizer progress supplied.</p>' : `<p>${escapeHtml(optimizer.name)} · ${escapeHtml(optimizer.status)} · evaluations ${optimizer.evaluations}/${optimizer.maxMetricCalls} · proposals ${optimizer.proposals}/${optimizer.maxProposals}</p><p>Selected candidate: ${escapeHtml(optimizer.selectedCandidateId ?? 'None supplied')}</p>`}
${lineage(data)}${table(['Candidate', 'Parents', 'Validation score', 'Discovery evaluations', 'Editable paths'], data.candidates.map((candidate) => [candidate.id, candidate.parentIds.join(', ') || 'Baseline', shown(candidate.validationScore), String(candidate.discoveryEvaluations), candidate.editablePaths.join('\n')]))}</section>
<section id="costs"><h2>Estimated and recorded costs</h2>${costView(data.costs)}</section>
<section id="usage"><h2>Usage by purpose</h2>${table(['Purpose', 'Model', 'Model attribution', 'Route', 'Input', 'Cache reads', 'Cache writes', 'Output', 'Reasoning', 'Source'], usage)}</section>
</main><script nonce="${escapeHtml(nonce)}">${viewerScript}</script></body></html>`;
}
