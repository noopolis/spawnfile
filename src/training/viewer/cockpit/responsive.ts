/** Viewport ownership and narrow-screen layout; data panels scroll internally. */
export const cockpitResponsiveStyles = `
/* Keep the console frame fixed. Only data panes own overflow. */
.view-pane { min-height: 0; height: 100%; overflow: auto; padding-top: 9px; }
.view-pane[data-view-pane="overview"] { overflow: hidden; padding-top: 0; }
.metric-view { height: 100%; min-height: 0; display: grid; grid-template-rows: auto minmax(180px, 270px) minmax(145px, 1fr); gap: 22px; }
.cockpit-main { overflow: hidden; padding-top: 0; }
.chart-grid { min-height: 0; }
.chart-grid .panel { min-height: 0; overflow: visible; }
.convergence-panel .panel-body { display: flex; flex-direction: column; min-height: 0; padding-bottom: 4px; }
.chart-wrap { flex: 1; min-height: 0; }
.chart-svg { height: 100%; min-height: 0; overflow: hidden; }
.comparison-panel .panel-body { overflow: auto; }
.chart-caption { flex-shrink: 0; padding: 8px 12px; }
.matrix-panel { min-height: 0; display: flex; }
.matrix-body { min-height: 0; display: flex; flex-direction: column; width: 100%; padding-top: 12px; }
.matrix-body > .scroll { flex: 1; min-height: 0; overflow: auto; }
.matrix-body .panel-footer { flex-shrink: 0; padding: 7px 12px; }
.matrix-table thead { position: sticky; top: 0; background: var(--bg); z-index: 1; }
.matrix-table th, .matrix-table td { padding: 7px 12px; }
@media (max-width: 900px) {
  .workspace { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); gap: 18px; padding: 16px 12px 10px; }
  .sidebar { display: block; overflow: visible; padding: 0; margin: 0; }
  .sidebar > section { display: none; }
  .sidebar nav .panel-body { flex-direction: row; padding: 10px 8px 7px; gap: 6px; }
  .sidebar .nav-item { justify-content: center; padding: 6px; }
  .nav-count { display: none; }
  .top-title { max-width: 34ch; }
  .chart-grid { grid-template-columns: minmax(0, 1.7fr) minmax(210px, 1fr); gap: 14px; }
  .details-grid { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 600px) {
  .topbar { min-height: 50px; gap: 6px; padding: 8px 10px; }
  .brand { font-size: 11px; gap: 5px; }
  .top-title { display: none; }
  .header-actions { gap: 6px; flex-wrap: nowrap; }
  .header-actions label { font-size: 10px; }
  .badge { font-size: 9px; }
  .refresh-button { padding: 4px 6px; font-size: 10px; }
  .workspace { padding: 14px 7px 6px; gap: 15px; }
  .sidebar .panel-title { display: none; }
  .sidebar .nav-item { padding: 4px 2px; font-size: 10px; }
  .sidebar nav .panel-body { padding: 5px; }
  .metric-view { gap: 16px; grid-template-rows: auto minmax(0, 1fr) minmax(110px, 26%); }
  .metric-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; }
  .metric-card { padding: 7px 6px; }
  .metric-label { font-size: 8px; letter-spacing: 0; }
  .metric-value { font-size: 21px; margin: 4px 0; }
  .metric-card:last-child .metric-value { font-size: 15px; }
  .metric-note { font-size: 8px; line-height: 1.35; }
  .chart-grid { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) auto; gap: 16px; }
  .panel-body { padding: 14px 10px 6px; }
  .chart-controls { gap: 5px; flex-wrap: nowrap; font-size: 10px; }
  .chart-select { padding: 3px; font-size: 9px; max-width: 54%; }
  .chart-legend { margin-top: 5px; font-size: 9px; gap: 12px; }
  .chart-caption { padding: 5px 8px; font-size: 9px; line-height: 1.35; }
  .comparison-panel .panel-body { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .comparison-panel .eyebrow, .comparison-panel .chart-caption { display: none; }
  .comparison-title { grid-column: 1 / -1; margin: 0; font-size: 13px; }
  .score-row { margin: 0; }
  .score-name { font-size: 10px; }
  .score-number { font-size: 16px; }
  .matrix-body .panel-footer { font-size: 9px; line-height: 1.3; padding: 4px 7px; }
  .matrix-table th, .matrix-table td { padding: 5px 7px; font-size: 10px; }
  .statusbar { padding: 6px 9px; font-size: 8px; gap: 4px; }
  .status-group { gap: 8px; }
  .statusbar .status-group:last-child > span:first-child { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; }
}
`;
