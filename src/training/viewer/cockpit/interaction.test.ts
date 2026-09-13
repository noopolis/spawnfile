import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { cockpitScript } from './interaction.js';

function element(dataset: Record<string, string> = {}) {
  const listeners = new Map<string, () => void>();
  const attributes = new Map<string, string>();
  const classes = new Set<string>();
  return { dataset, attributes, classes, hidden: false, value: '0', checked: false, open: false,
    classList: { toggle: (name: string, enabled: boolean) => enabled ? classes.add(name) : classes.delete(name) },
    addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    fire: (name: string) => listeners.get(name)!(), focus: vi.fn(), scrollIntoView: vi.fn() };
}

function fixture(hash = '') {
  const buttons = ['overview', 'trials', 'costs', 'provenance'].map(view => element({ viewButton: view }));
  const panes = ['overview', 'trials', 'costs', 'provenance'].map(view => element({ viewPane: view }));
  const selects = [element(), element()];
  const metrics = [element({ metricPanel: '0' }), element({ metricPanel: '1' })];
  const open = element({ openTrial: '0' }), drawer = element(), refresh = element(), poll = element();
  let fragment = hash;
  const location = { get hash() { return fragment; }, set hash(value: string) { fragment = value.startsWith('#') ? value : `#${value}`; }, search: '', reload: vi.fn() };
  let tick!: () => void;
  const document = { visibilityState: 'visible',
    querySelectorAll: (selector: string) => new Map([
      ['[data-view-button]', buttons], ['[data-view-pane]', panes], ['[data-metric-select]', selects],
      ['[data-metric-panel]', metrics], ['[data-open-trial]', [open]],
    ]).get(selector),
    getElementById: (id: string) => new Map([['trial-0', drawer], ['refresh', refresh], ['poll', poll]]).get(id) };
  const interval = vi.fn((callback: () => void) => { tick = callback; });
  runInNewContext(cockpitScript, { document, location, setInterval: interval });
  return { buttons, panes, selects, metrics, open, drawer, refresh, poll, location, document, interval, tick: () => tick() };
}

describe('shipped cockpit browser controls', () => {
  it('restores navigation and selected metric without requiring server writes', () => {
    const f = fixture('#costs/1');
    expect(f.buttons[2]!.attributes.get('aria-pressed')).toBe('true');
    expect(f.panes.map(pane => pane.hidden)).toEqual([true, true, false, true]);
    expect(f.metrics.map(pane => pane.hidden)).toEqual([true, false]);
    expect(f.selects.map(select => select.value)).toEqual(['1', '1']);
    f.buttons[0]!.fire('click');
    expect(f.location.hash).toBe('#overview/1');
    f.selects[0]!.value = '0'; f.selects[0]!.fire('change');
    expect(f.location.search).toBe('?metric=0');
    expect(f.metrics.map(pane => pane.hidden)).toEqual([true, false]);
  });

  it('falls back from unknown hash values and opens only the requested trial', () => {
    const f = fixture('#untrusted/999');
    expect(f.location.hash).toBe('#overview/0');
    expect(f.panes[0]!.hidden).toBe(false);
    f.open.fire('click');
    expect(f.location.hash).toBe('#trials/0');
    expect(f.drawer.open).toBe(true);
    expect(f.drawer.focus).toHaveBeenCalledOnce();
    expect(f.drawer.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('refreshes only on request or opted-in visible polling; no inference endpoint is referenced', () => {
    const f = fixture();
    f.tick(); expect(f.location.reload).not.toHaveBeenCalled();
    f.poll.checked = true; f.document.visibilityState = 'hidden'; f.tick();
    expect(f.location.reload).not.toHaveBeenCalled();
    f.document.visibilityState = 'visible'; f.tick();
    expect(f.location.reload).toHaveBeenCalledOnce();
    f.poll.checked = false; f.refresh.fire('click');
    expect(f.location.reload).toHaveBeenCalledTimes(2);
    expect(f.interval).toHaveBeenCalledWith(expect.any(Function), 5000);
    expect(cockpitScript).not.toMatch(/fetch|POST|localStorage|sendBeacon|__name/);
  });
});
