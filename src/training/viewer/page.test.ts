import { describe, expect, it } from 'vitest';
import { viewerFixture } from './fixture.js';
import { escapeHtml, renderViewer, viewerScript } from './page.js';
import { renderCockpit } from './cockpit/index.js';

describe('read-only experiment page entry point', () => {
  it('serves the cockpit with recorded scores and collapsed evidence', () => {
    const data = viewerFixture(), page = renderViewer(data, 'nonce');
    expect(page).toBe(renderCockpit(data, 'nonce'));
    for (const text of ['Local experiment', 'trial-1', 'dspy.GEPA', '4/7', '1/2', 'partial',
      'Required checks', 'A known check', 'event-1', 'subscription', 'Unknown', 'skills/review.md']) {
      expect(page).toContain(text);
    }
    expect(page).toContain('class="chart-svg" role="img"');
    expect(page).toContain('<th scope="col">');
    expect(page).toContain('data-view-pane="trials" hidden');
    expect(page).toContain('provider-reported');
    expect(page).not.toMatch(/<details[^>]*\bopen(?:[\s=>])/);
    expect(viewerScript).toContain('location.reload()');
    expect(viewerScript).not.toMatch(/fetch|POST|localStorage|sendBeacon|XMLHttpRequest|WebSocket|invoke|spawn/);
  });

  it('escapes all five HTML delimiters throughout rendered values and nonce attributes', () => {
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

  it('shows unknown observations and parent identities without inventing a graph', () => {
    const data = viewerFixture();
    data.trials[0]!.score = null; data.trials[0]!.checks = []; data.trials[0]!.events = [];
    data.candidates = [{ ...data.candidates[0]!, validationScore: null, parentIds: ['not-observed'] }];
    data.optimizer!.selectedCandidateId = undefined;
    const page = renderViewer(data, 'n');
    expect(page).toContain('score Unknown');
    expect(page).toContain('No checks supplied.');
    expect(page).toContain('Selected candidate: None supplied');
    expect(page).toContain('<td>not-observed</td>');
    expect(page).not.toContain('<circle');
    data.cases = []; data.trials = []; data.candidates = []; data.usage = []; data.optimizer = undefined;
    const empty = renderViewer(data, 'n');
    expect(empty).toContain('No trials supplied.');
    expect(empty).toContain('No optimizer progress supplied.');
    expect(empty).toContain('No measured scores yet.');
    expect(empty).not.toContain('<svg');
  });
});
