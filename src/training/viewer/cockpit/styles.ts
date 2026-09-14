import { cockpitResponsiveStyles } from './responsive.js';

/** Local cockpit shell and data graphics, following the Moltnet console system. */
export const cockpitStyles = `
.activity-measurements { max-height:180px; overflow:auto; }
:root {
  color-scheme: dark;
  --bg: #0b0b0b;
  --surface: #111111;
  --ink: #f3eee7;
  --sub: #d1c7b8;
  --mute: #a59d94;
  --faint: #6b6560;
  --green: #3ddc84;
  --cyan: #00e5cc;
  --coral: #d4604a;
  --line: rgba(61, 220, 132, .45);
  --line-soft: rgba(61, 220, 132, .18);
  --tint: rgba(61, 220, 132, .06);
  font: 13px/1.5 "JetBrains Mono", "SF Mono", Menlo, "Cascadia Code", Consolas, ui-monospace, monospace;
  background: var(--bg);
  color: var(--ink);
}
* { box-sizing: border-box; min-width: 0; }
html, body { margin: 0; height: 100%; }
body { overflow: hidden; -webkit-font-smoothing: antialiased; }
h1, h2, h3, p { margin: 0; }
a { color: inherit; text-underline-offset: 3px; }
button, select, input { font: inherit; color: inherit; }
button, select, summary { cursor: pointer; }
button, select { border: 1px solid var(--line-soft); background: var(--surface); }
button:focus-visible, select:focus-visible, a:focus-visible, summary:focus-visible {
  outline: 2px solid var(--cyan);
  outline-offset: 3px;
}
button:hover, select:hover { border-color: var(--green); }
input { accent-color: var(--green); }
::selection { background: var(--green); color: var(--bg); }
[hidden] { display: none !important; }
* { scrollbar-width: thin; scrollbar-color: var(--line-soft) transparent; }
.shell {
  height: 100vh;
  height: 100dvh;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
}
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  min-height: 58px;
  padding: 12px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, .07);
}
.brand, .header-actions, .status-group, .chart-legend, .cost-legend {
  display: flex;
  align-items: center;
  gap: 12px;
}
.brand { color: var(--green); font-weight: 700; letter-spacing: .16em; }
.brand-mark { font-size: 22px; line-height: 1; }
.top-title { color: var(--sub); font-weight: 400; letter-spacing: 0; }
.header-actions { flex-wrap: wrap; justify-content: flex-end; font-size: 11px; }
.badge {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 3px 8px;
  border: 1px solid currentColor;
  border-radius: 3px;
  color: var(--mute);
  font-size: 10px;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.good, .positive, .pass { color: var(--green); }
.warn, .bad, .negative, .fail { color: var(--coral); }
.muted, .neutral, .unknown { color: var(--mute); }
.faint { color: var(--faint); }
.dot {
  display: inline-block;
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.refresh-button { padding: 6px 10px; border-radius: 3px; color: var(--green); }
.workspace {
  display: grid;
  grid-template-columns: 236px minmax(0, 1fr);
  gap: 18px;
  min-height: 0;
  padding: 20px 18px 14px;
  overflow: hidden;
}
.sidebar {
  display: flex;
  flex-direction: column;
  gap: 24px;
  overflow: auto;
  padding: 10px 1px 2px;
  margin-top: -10px;
}
.panel {
  position: relative;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--bg);
  scroll-margin-top: 12px;
}
.panel-title {
  position: absolute;
  top: -9px;
  left: 14px;
  max-width: calc(100% - 28px);
  padding: 0 8px;
  background: var(--bg);
  color: var(--green);
  font-size: 11px;
  font-weight: 400;
  letter-spacing: .12em;
  line-height: 16px;
  text-transform: uppercase;
}
.panel-title::before { content: "[ "; }
.panel-title::after { content: " ]"; }
.panel-body { padding: 21px 16px 16px; }
.panel-footer, .chart-caption {
  padding: 10px 16px;
  border-top: 1px dashed rgba(255, 255, 255, .08);
  color: var(--mute);
  font-size: 11px;
}
.sidebar .panel-body { display: flex; flex-direction: column; gap: 12px; }
.experiment-label { font-size: 15px; line-height: 1.55; overflow-wrap: anywhere; }
.sidebar .muted, .sidebar .mono-id { font-size: 11px; }
.nav-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 10px;
  border: 1px solid transparent;
  border-radius: 3px;
  color: var(--sub);
  text-decoration: none;
}
.nav-item:hover, .nav-item.active { border-color: var(--line-soft); background: var(--tint); color: var(--green); }
.nav-count { color: var(--mute); font-size: 11px; font-variant-numeric: tabular-nums; }
.cockpit-main {
  display: flex;
  flex-direction: column;
  gap: 24px;
  min-height: 0;
  overflow: auto;
  padding: 0 5px 6px 1px;
}
.view-pane, .metric-view { display: flex; flex-direction: column; gap: 24px; }
.top-title { max-width: 48ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-item { width: 100%; background: transparent; text-align: left; }
.budget-row { display: flex; justify-content: space-between; gap: 12px; }
.comparison-title { margin: 8px 0 25px; font-size: 18px; font-weight: 400; }
.matrix-body { padding-top: 16px; }
.trial-button { border: 0; background: none; text-align: left; padding: 0; color: var(--sub); }
.trial-button:hover { color: var(--green); }
.detail-drawer { flex-shrink: 0; }
.inspector .compact-table td { overflow-wrap: anywhere; max-width: 32ch; }
.inspector .panel, .metric-view > .panel, .chart-grid > .panel { flex-shrink: 0; }
.overview-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.eyebrow, .metric-label { color: var(--mute); font-size: 10px; letter-spacing: .12em; text-transform: uppercase; }
.outcome-title {
  margin-top: 5px;
  font-size: clamp(22px, 2.2vw, 30px);
  font-weight: 500;
  letter-spacing: -.04em;
  line-height: 1.3;
  overflow-wrap: anywhere;
}
.outcome-detail { margin-top: 7px; color: var(--sub); font-size: 12px; max-width: 75ch; overflow-wrap: anywhere; }
.metric-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.metric-card {
  padding: 14px 16px 12px;
  border: 1px solid var(--line-soft);
  border-radius: 3px;
  background: var(--surface);
}
.metric-value {
  margin: 6px 0 4px;
  font-size: clamp(23px, 2.4vw, 34px);
  font-weight: 500;
  line-height: 1.2;
  letter-spacing: -.05em;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.metric-note { color: var(--mute); font-size: 11px; overflow-wrap: anywhere; }
.chart-grid {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(260px, 1fr);
  gap: 18px;
}
.convergence-panel, .comparison-panel { display: flex; flex-direction: column; }
.convergence-panel .panel-body, .comparison-panel .panel-body { flex: 1; }
.chart-controls { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
.segmented { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--line-soft); border-radius: 3px; }
.segmented button { border: 0; border-radius: 2px; padding: 4px 8px; color: var(--mute); font-size: 11px; }
.segmented [aria-pressed="true"] { background: var(--tint); color: var(--green); }
.chart-select { max-width: 100%; padding: 5px 8px; border-radius: 3px; font-size: 11px; }
.chart-legend { flex-wrap: wrap; gap: 16px; margin-top: 14px; color: var(--sub); font-size: 11px; }
.legend-key { display: inline-flex; align-items: center; gap: 7px; }
.legend-key::before { content: ""; width: 16px; border-top: 2px solid currentColor; }
.legend-key.train { color: var(--green); }
.legend-key.validation { color: var(--cyan); }
.chart-wrap { margin-top: 10px; }
.chart-svg { display: block; width: 100%; height: auto; overflow: visible; }
.chart-gridline { stroke: rgba(255, 255, 255, .08); stroke-dasharray: 3 5; }
.chart-axis { stroke: var(--faint); stroke-width: 1; }
.chart-tick { fill: var(--mute); font-size: 11px; font-family: inherit; }
.chart-train, .chart-validation { fill: none; stroke-width: 2.5; stroke-linejoin: round; stroke-linecap: round; }
.chart-train { stroke: var(--green); }
text.chart-train { fill: var(--green); stroke: none; }
text.chart-validation { fill: var(--cyan); stroke: none; }
.chart-validation { stroke: var(--cyan); }
.chart-point { fill: var(--bg); stroke: var(--green); stroke-width: 2; }
.chart-point.validation { stroke: var(--cyan); }
.chart-point[data-selected="true"] { fill: var(--cyan); stroke: var(--bg); stroke-width: 3; }
.chart-area { fill: rgba(61, 220, 132, .07); stroke: none; }
.chart-caption { margin-top: auto; line-height: 1.6; }
.score-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 48px;
  align-items: center;
  gap: 8px 10px;
  margin: 0 0 20px;
}
.score-name { color: var(--sub); font-size: 12px; overflow-wrap: anywhere; }
.score-track { width: 100%; grid-column: 1; height: 9px; overflow: hidden; border-radius: 2px; background: rgba(255, 255, 255, .06); }
.score-fill { fill: var(--cyan); }
.score-fill[data-phase="baseline"] { fill: var(--faint); }
.score-fill[data-phase="train"] { fill: var(--green); }
.score-number { grid-column: 2; grid-row: 1 / span 2; text-align: right; font-size: 22px; font-variant-numeric: tabular-nums; }
.scroll { max-width: 100%; overflow-x: auto; }
.matrix-table, .compact-table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { padding: 10px 12px; text-align: left; vertical-align: middle; border-bottom: 1px solid rgba(255, 255, 255, .07); }
th { color: var(--mute); font-size: 10px; font-weight: 400; letter-spacing: .06em; text-transform: uppercase; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover { background: var(--tint); }
.matrix-table th:not(:first-child), .matrix-table td:not(:first-child) { text-align: center; white-space: nowrap; }
.matrix-table .case-label { max-width: 260px; }
.case-label { color: var(--sub); overflow-wrap: anywhere; }
.mono-id { color: var(--mute); font-size: 11px; overflow-wrap: anywhere; }
.status-cell {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  min-width: 46px;
  padding: 3px 7px;
  border-radius: 3px;
  font-size: 11px;
}
.status-cell.pass { background: rgba(61, 220, 132, .1); }
.status-cell.fail { background: rgba(212, 96, 74, .12); }
.status-cell.unknown { border: 1px dashed rgba(165, 157, 148, .35); }
.detail-drawer { border: 1px solid var(--line-soft); border-radius: 3px; }
.detail-drawer > summary { padding: 12px 14px; color: var(--sub); }
.detail-drawer[open] > summary { border-bottom: 1px solid var(--line-soft); color: var(--green); }
.details-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; padding: 16px; }
.inspector { overflow-wrap: anywhere; }
.inspector h3 { margin-bottom: 10px; color: var(--green); font-size: 12px; font-weight: 400; }
.inspector ul { padding-left: 18px; }
.inspector li { margin: 8px 0; }
.inspector p { margin: 8px 0; }
.compact-table { font-size: 11px; }
.compact-table th, .compact-table td { padding: 8px 10px; }
.cost-panel .metric-grid { margin-bottom: 16px; }
.cost-stack { display: flex; height: 16px; gap: 3px; margin: 14px 0; overflow: hidden; border-radius: 2px; background: var(--surface); }
.cost-stack { width: 100%; }
.cost-segment { fill: var(--green); stroke: var(--bg); stroke-width: .3; }
.cost-segment[data-role="optimizer"] { fill: var(--cyan); }
.cost-segment[data-role="judge"] { fill: var(--coral); }
.cost-legend { display: grid; gap: 10px; }
.cost-legend > div { display: grid; grid-template-columns: 16px 1fr auto auto; gap: 12px; }
.legend-key[data-role="subject"] { color: var(--green); }
.legend-key[data-role="judge"] { color: var(--coral); }
.legend-key[data-role="optimizer"] { color: var(--cyan); }
.cost-legend { flex-wrap: wrap; color: var(--sub); font-size: 11px; }
.statusbar {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 22px;
  padding: 8px 20px;
  border-top: 1px solid rgba(255, 255, 255, .07);
  color: var(--mute);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.status-group { flex-wrap: wrap; gap: 18px; }
.status-value { color: var(--sub); }
.empty-state {
  display: grid;
  place-content: center;
  gap: 8px;
  min-height: 180px;
  padding: 24px;
  text-align: center;
  color: var(--mute);
}
.empty-state strong { color: var(--sub); font-weight: 400; }
.screen-reader-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
@media (max-width: 1150px) {
  .workspace { grid-template-columns: 210px minmax(0, 1fr); gap: 14px; padding-right: 12px; padding-left: 12px; }
  .chart-grid { grid-template-columns: minmax(0, 1.6fr) minmax(230px, 1fr); gap: 14px; }
  .metric-card { padding: 12px; }
  .brand { flex-wrap: wrap; gap: 8px; }
  .top-title { font-size: 11px; }
}
${cockpitResponsiveStyles}
`;
