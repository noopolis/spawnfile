/** Browser payload has no imports, model calls or storage access. Exercised as shipped in VM and browser tests. */
export const cockpitScript = `
(function () {
  const buttons = Array.from(document.querySelectorAll('[data-view-button]'));
  const panes = Array.from(document.querySelectorAll('[data-view-pane]'));
  const selects = Array.from(document.querySelectorAll('[data-metric-select]'));
  const metricPanes = Array.from(document.querySelectorAll('[data-metric-panel]'));
  const display = (view, metric) => {
    const target = buttons.some(button => button.dataset.viewButton === view) ? view : 'overview';
    const chosen = metricPanes.some(pane => pane.dataset.metricPanel === metric) ? metric : (metricPanes[0]?.dataset.metricPanel ?? '0');
    for (const button of buttons) {
      const active = button.dataset.viewButton === target;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    for (const pane of panes) pane.hidden = pane.dataset.viewPane !== target;
    for (const pane of metricPanes) pane.hidden = pane.dataset.metricPanel !== chosen;
    for (const select of selects) select.value = chosen;
    location.hash = target + '/' + chosen;
  };
  const current = () => location.hash.slice(1).split('/');
  for (const button of buttons) button.addEventListener('click', () => display(button.dataset.viewButton, current()[1] ?? '0'));
  for (const select of selects) select.addEventListener('change', () => { location.search = '?metric=' + select.value; });
  for (const button of document.querySelectorAll('[data-open-trial]')) {
    button.addEventListener('click', () => {
      display('trials', current()[1] ?? '0');
      const drawer = document.getElementById('trial-' + button.dataset.openTrial);
      drawer.open = true; drawer.scrollIntoView({ block: 'nearest' }); drawer.focus();
    });
  }
  document.getElementById('refresh').addEventListener('click', () => location.reload());
  setInterval(() => {
    if ((document.getElementById('poll')).checked && document.visibilityState !== 'hidden') location.reload();
  }, 5000);
  display(current()[0] ?? 'overview', current()[1] ?? '0');
})();
`;
