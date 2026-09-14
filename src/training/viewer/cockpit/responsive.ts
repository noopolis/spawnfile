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
@media (max-height: 700px) {
  .view-pane[data-view-pane="overview"] { overflow: auto; }
  .metric-view { height: auto; min-height: 100%; grid-template-rows: max-content max-content minmax(145px, 1fr); }
  .chart-grid { min-height: min-content; }
  .convergence-panel .panel-body { flex: none; min-height: min-content; }
  .chart-wrap { flex: none; height: 140px; min-height: 140px; }
}
@media (min-width: 901px) and (max-height: 700px) {
  .sidebar { gap: 12px; }
  .sidebar > section { min-height: 60px; }
  .sidebar > section > .panel-body { padding: 10px 10px 6px; gap: 6px; }
  .sidebar .panel-footer { padding: 6px 10px; }
  .sidebar > nav > .panel-body { padding: 12px 8px; gap: 4px; }
  .sidebar .nav-item { padding: 3px; }
}
@media (max-width: 900px) {
  .workspace { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); gap: 18px; padding: 16px 12px 10px; }
  .sidebar { display: block; overflow: hidden; padding: 9px 1px 1px; margin: -9px -1px -1px; }
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
  .brand { gap: 5px; }
  .top-title { display: none; }
  .header-actions { gap: 6px; flex-wrap: nowrap; }
  .refresh-button { padding: 4px 6px; }
  .workspace { padding: 14px 7px 6px; gap: 15px; }
  .sidebar .panel-title { display: none; }
  .sidebar .nav-item { padding: 4px 2px; }
  .sidebar nav .panel-body { padding: 5px; }
  .view-pane[data-view-pane="overview"] { overflow: auto; }
  .metric-view { height: auto; min-height: 100%; gap: 16px; grid-template-rows: max-content max-content minmax(145px, 1fr); }
  .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; }
  .metric-card { padding: 7px 6px; }
  .metric-label { letter-spacing: 0; }
  .metric-value { margin: 4px 0; }
  .metric-note { line-height: 1.35; }
  .chart-grid { min-height: min-content; grid-template-columns: minmax(0, 1fr); grid-template-rows: max-content max-content; gap: 16px; }
  .convergence-panel .panel-body { flex: none; min-height: min-content; }
  .chart-wrap { flex: none; height: 140px; min-height: 140px; }
  .panel-body { padding: 14px 10px 6px; }
  .chart-controls { gap: 5px; flex-wrap: nowrap; }
  .chart-select { padding: 3px; max-width: 54%; }
  .chart-legend { margin-top: 5px; gap: 12px; }
  .chart-caption { padding: 5px 8px; line-height: 1.35; }
  .comparison-panel .panel-body { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .comparison-panel .eyebrow, .comparison-panel .chart-caption { display: none; }
  .comparison-title { grid-column: 1 / -1; margin: 0; }
  .score-row { margin: 0; }
  .matrix-body .panel-footer { line-height: 1.3; padding: 4px 7px; }
  .matrix-table th, .matrix-table td { padding: 5px 7px; }
  .statusbar { padding: 6px 9px; gap: 4px; }
  .status-group { gap: 8px; }
  .statusbar .status-group:last-child > span:first-child { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; }
}
`;
