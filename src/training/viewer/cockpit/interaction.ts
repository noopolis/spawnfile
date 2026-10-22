/** Shipped read-only browser controller; source data comes only from the local viewer. */
export const cockpitScript = `
(function () {
  let stream, controller, fetching = false, pending = false, unloaded = false, terminal = false;
  const current = () => location.hash.slice(1).split('/');
  const state = text => { const label = document.getElementById('stream-state'); if (label) label.textContent = text; };
  const drawers = () => Array.from(document.querySelectorAll('[data-view-pane]')).flatMap(pane => {
    const positions = new Map();
    return Array.from(pane.querySelectorAll('details')).map(node => {
      const identity = node.closest('[data-trial-key]')?.dataset.trialKey ?? null;
      const ordinal = positions.get(identity) ?? 0; positions.set(identity, ordinal + 1);
      return [JSON.stringify([pane.dataset.viewPane, identity, ordinal]), node];
    });
  });
  const display = (view, metric) => {
    const buttons = Array.from(document.querySelectorAll('[data-view-button]'));
    const panes = Array.from(document.querySelectorAll('[data-view-pane]'));
    const metrics = Array.from(document.querySelectorAll('[data-metric-panel]'));
    const target = buttons.some(button => button.dataset.viewButton === view) ? view : 'overview';
    const chosen = metrics.some(pane => pane.dataset.metricPanel === metric) ? metric : (metrics[0]?.dataset.metricPanel ?? '0');
    for (const button of buttons) {
      const active = button.dataset.viewButton === target;
      button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
    }
    for (const pane of panes) pane.hidden = pane.dataset.viewPane !== target;
    for (const pane of metrics) pane.hidden = pane.dataset.metricPanel !== chosen;
    for (const select of document.querySelectorAll('[data-metric-select]')) select.value = chosen;
    location.hash = target + '/' + chosen;
  };
  const apply = next => {
    // Read presentation state at commit time: the user may interact before a snapshot arrives.
    const live = document.getElementById('poll').checked;
    const scroll = new Map(Array.from(document.querySelectorAll('[data-view-pane], .sidebar')).map(pane => [pane.dataset.viewPane ?? 'sidebar', pane.scrollTop]));
    const opened = new Map(drawers().map(([key, node]) => [key, node.open]));
    const focusId = document.activeElement?.id;
    document.querySelector('.shell').replaceWith(next);
    document.getElementById('poll').checked = live;
    bind(); display(current()[0], current()[1]);
    for (const pane of document.querySelectorAll('[data-view-pane], .sidebar')) pane.scrollTop = scroll.get(pane.dataset.viewPane ?? 'sidebar') ?? 0;
    for (const [key, node] of drawers()) node.open = opened.get(key) ?? false;
    if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
  };
  const refresh = async () => {
    if (unloaded || terminal) return;
    if (fetching) { pending = true; return; }
    fetching = true;
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 10000);
    try {
      const response = await fetch(location.pathname + location.search, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error();
      const next = new DOMParser().parseFromString(await response.text(), 'text/html').querySelector('.shell');
      if (!next) throw new Error();
      if (unloaded || terminal) return;
      apply(next);
      const live = document.getElementById('poll').checked;
      state(live ? (stream?.readyState === 1 ? 'Streaming' : 'Connecting') : 'Paused');
    } catch { if (!unloaded && !terminal) state('Snapshot unavailable'); }
    finally { clearTimeout(timeout); controller = undefined; fetching = false; if (pending) { pending = false; void refresh(); } }
  };
  const connect = () => {
    stream?.close(); stream = undefined;
    if (terminal) { state('Viewer closed'); return; }
    if (!document.getElementById('poll').checked) { pending = false; state('Paused'); return; }
    state('Connecting');
    const connection = new EventSource('/api/events' + location.search); stream = connection;
    const active = () => stream === connection && !unloaded && !terminal;
    stream.addEventListener('open', () => { if (active()) state('Streaming'); });
    stream.addEventListener('snapshot', () => { if (active() && document.visibilityState !== 'hidden') void refresh(); });
    stream.addEventListener('final', event => {
      if (!active()) return;
      terminal = true; pending = false; controller?.abort(); connection.close();
      try {
        const payload = JSON.parse(event.data);
        if (typeof payload.html === 'string') {
          const next = new DOMParser().parseFromString(payload.html, 'text/html').querySelector('.shell');
          if (!next) throw new Error();
          apply(next);
        }
        document.getElementById('poll').checked = false;
        state('Viewer closed');
      } catch { state('Final snapshot unavailable'); }
    });
    stream.addEventListener('unavailable', () => { if (active()) state('Snapshot unavailable'); });
    stream.addEventListener('error', () => { if (active()) state('Disconnected · reconnecting'); });
  };
  const bind = () => {
    for (const button of document.querySelectorAll('[data-view-button]')) button.addEventListener('click', () => display(button.dataset.viewButton, current()[1] ?? '0'));
    for (const select of document.querySelectorAll('[data-metric-select]')) select.addEventListener('change', () => { location.search = '?metric=' + select.value; });
    for (const button of document.querySelectorAll('[data-open-trial]')) button.addEventListener('click', () => {
      display('trials', current()[1] ?? '0');
      const drawer = document.getElementById('trial-' + button.dataset.openTrial);
      if (drawer) { drawer.open = true; drawer.scrollIntoView({ block: 'nearest' }); drawer.focus(); }
    });
    document.getElementById('refresh').addEventListener('click', () => { void refresh(); });
    document.getElementById('poll').addEventListener('change', connect);
  };
  bind(); display(current()[0] ?? 'overview', current()[1] ?? '0'); connect();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && document.getElementById('poll').checked) void refresh(); });
  window.addEventListener('beforeunload', () => { unloaded = true; pending = false; stream?.close(); controller?.abort(); });
})();
`;
