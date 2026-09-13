import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { viewerFixture } from './fixture.js';
import { escapeHtml, renderViewer, viewerScript } from './page.js';

describe('read-only experiment page', () => {
  it('shows supplied cases, progress, lineage, coverage, checks, events and honest usage', () => {
    const page = renderViewer(viewerFixture(), 'nonce');
    for (const text of ['Local experiment', 'Training case', 'trial-1', 'dspy.GEPA', '4/7', '1/2',
      'partial', 'Required checks', 'A known check', 'event-1', 'subscription', 'Unknown', 'skills/review.md']) {
      expect(page).toContain(text);
    }
    expect(page).toContain('<line x1="80"');
    expect(page).toContain('role="img"');
    expect(page).toContain('<th scope="col">');
    expect(viewerScript).toContain('location.reload()');
    expect(viewerScript).not.toMatch(/fetch|POST|localStorage|sendBeacon/);
  });

  it('escapes all five HTML delimiters in titles, tables, checks, evidence, SVG and attributes', () => {
    const payload = `'"><script>alert(1)</script>&`;
    const data = viewerFixture();
    data.experiment.title = payload; data.cases[0]!.id = payload;
    data.trials[0]!.checks[0]!.label = payload; data.trials[0]!.events[0]!.summary = payload;
    data.candidates[0]!.id = payload; data.optimizer!.name = payload;
    const page = renderViewer(data, payload);
    expect(page).not.toContain(payload);
    expect(page).not.toContain('<script>alert(1)');
    expect(page.match(/&lt;script&gt;/g)!.length).toBeGreaterThan(5);
    expect(escapeHtml(payload)).toBe('&#39;&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;');
  });

  it('makes missing entries/observations explicit and never invents a missing parent edge', () => {
    const data = viewerFixture();
    data.trials[0]!.score = null; data.trials[0]!.checks = []; data.trials[0]!.events = [];
    data.candidates = [{ ...data.candidates[0]!, validationScore: null, parentIds: ['not-observed'] }];
    data.optimizer!.selectedCandidateId = undefined;
    const page = renderViewer(data, 'n');
    expect(page).toContain('score Unknown'); expect(page).toContain('No checks supplied.');
    expect(page).toContain('Selected candidate: None supplied'); expect(page).not.toContain('<line');
    data.cases = []; data.trials = []; data.candidates = []; data.usage = []; data.optimizer = undefined;
    const empty = renderViewer(data, 'n');
    expect(empty).toContain('No trials supplied.'); expect(empty).toContain('No optimizer progress supplied.');
    expect(empty).not.toContain('<svg');
  });

  it('executes only reloads and resumes recurring polling after the checkbox is reenabled', () => {
    const reload = vi.fn();
    const checkbox = { checked: false };
    let tick!: () => void;
    let click!: () => void;
    const setInterval = vi.fn((callback: () => void) => { tick = callback; });
    runInNewContext(viewerScript, { location: { reload }, setInterval, document: {
      getElementById: (id: string) => id === 'poll' ? checkbox : {
        addEventListener: (event: string, callback: () => void) => { expect(event).toBe('click'); click = callback; },
      },
    } });
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 5000);
    tick(); expect(reload).not.toHaveBeenCalled();
    checkbox.checked = true; tick(); expect(reload).toHaveBeenCalledTimes(1);
    checkbox.checked = false; tick(); expect(reload).toHaveBeenCalledTimes(1);
    click(); expect(reload).toHaveBeenCalledTimes(2);
  });
});
