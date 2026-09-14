import { describe, expect, it } from 'vitest';
import { viewerFixture } from '../fixture.js';
import { renderCockpit } from './page.js';

describe('training cockpit page', () => {
  it('opens on the measured overview with all secondary views navigable and hidden', () => {
    const page = renderCockpit(viewerFixture(), 'test-nonce');
    expect(page).toContain('<div class="shell">');
    expect(page).toContain('data-view-button="overview" aria-pressed="true"');
    expect(page).toContain('data-view-pane="overview" aria-label="Training overview"');
    for (const view of ['trials', 'costs', 'provenance']) {
      expect(page).toContain(`data-view-button="${view}" aria-pressed="false"`);
      expect(page).toContain(`data-view-pane="${view}" hidden`);
    }
    expect(page).toContain('id="poll" type="checkbox" checked');
    expect(page).toContain('mode: <span class="status-value">live');
    expect(page).toContain('Selected: Candidate 1');
    expect(page).toContain('train 1 · validation 1 · test —');
    expect(page.match(/<script\b/g)).toHaveLength(1);
    expect(page).toContain('<script nonce="test-nonce">');
    expect(page).toContain('<style nonce="test-nonce">');
  });

  it.each(['completed', 'complete', 'failed'])('disables automatic refresh for terminal status %s', status => {
    const data = viewerFixture(); data.experiment.status = status;
    const page = renderCockpit(data, 'n');
    expect(page).toContain('id="poll" type="checkbox"> Live');
    expect(page).toContain('mode: <span class="status-value">replay');
    if (status === 'failed') {
      expect(page).toContain('class="badge bad"');
      expect(page).toContain('Run stopped');
      expect(page).toContain('class="negative">failed');
    }
  });

  it('keeps an explicit replay phase in replay mode', () => {
    const data = viewerFixture(); data.experiment.phase = 'replay';
    expect(renderCockpit(data, 'n')).toContain('id="poll" type="checkbox"> Live');
  });

  it('continues observing an ongoing final test and stops automatic refresh after completion', () => {
    const data = viewerFixture();
    data.experiment.phase = 'final-test'; data.experiment.status = 'testing frozen selection';
    expect(renderCockpit(data, 'n')).toContain('id="poll" type="checkbox" checked');
    expect(renderCockpit(data, 'n')).toContain('mode: <span class="status-value">live');
    data.experiment.status = 'completed';
    expect(renderCockpit(data, 'n')).toContain('id="poll" type="checkbox"> Live');
    expect(renderCockpit(data, 'n')).toContain('mode: <span class="status-value">replay');
  });

  it('shows explicit defaults without optimizer or cost-model observations', () => {
    const data = viewerFixture();
    data.experiment.title = 'Task — independent trial';
    data.optimizer = undefined; data.candidates = []; data.trials = []; data.cases = []; data.usage = [];
    const page = renderCockpit(data, 'n');
    expect(page).toContain('class="experiment-label">Task</p>');
    expect(page).toContain('class="muted">Evaluation</p>');
    expect(page).toContain('Selected: pending');
    expect(page).toContain('Evaluations</span><strong>—</strong>');
    expect(page).toContain('Model identity not supplied');
    expect(page).toContain('No trials supplied.');
    expect(page).not.toContain('<circle');
  });

  it('deduplicates reported model labels while keeping requested-model fallback visible', () => {
    const data = viewerFixture();
    const line = { role: 'optimizer', name: 'reflection', model: 'observed', requestedModel: 'requested',
      modelBasis: 'provider-reported' as const, provider: null, route: null, outcome: 'complete', usage: null,
      valuationStatus: 'unpriced', amount: null, price: null };
    data.costs = { observed: { total: null, knownSubtotal: { low: 0, high: 0 }, completeness: 'incomplete',
      usageCoverage: 'incomplete', groups: [], lines: [line, line, { ...line, model: null },
        { ...line, model: null, requestedModel: null }] } };
    const page = renderCockpit(data, 'n');
    expect(page).toContain('<p class="muted">observed · requested</p>');
    expect(page).not.toContain('observed · observed');
  });

  it('uses only numeric drilldown and selector attributes for hostile recorded identities', () => {
    const data = viewerFixture(), attack = '" autofocus onfocus="attack()';
    data.experiment.title = attack; data.experiment.id = attack; data.experiment.updatedAt = attack;
    data.trials[0]!.id = attack; data.trials[0]!.candidateId = attack;
    data.trials[0]!.checks[0]!.label = attack; data.candidates[0]!.id = attack;
    const page = renderCockpit(data, attack);
    expect(page).toContain('data-open-trial="0"');
    expect(page).toContain('data-metric-panel="0"');
    expect(page).toContain('id="trial-0"');
    expect(page).not.toContain('" autofocus');
    expect(page).not.toMatch(/data-(?:candidate|trial|metric)-id=/);
    expect(page).not.toMatch(/<[^>]+\sonfocus="attack\(\)"/);
    expect(page).toContain('&quot; autofocus onfocus=&quot;attack()');
  });

  it('renders one selected metric and one trial matrix, falling back from unknown indices', () => {
    const data = viewerFixture();
    for (const index of [0, 1, 2]) {
      const page = renderCockpit(data, 'n', index);
      expect(page.match(/class="chart-svg"/g)).toHaveLength(1);
      expect(page.match(/class="matrix-table"/g)).toHaveLength(1);
      expect(page).toContain(`data-metric-panel="${index}"`);
      expect(page).toContain(`<option value="${index}" selected>`);
    }
    expect(renderCockpit(data, 'n', 999)).toContain('data-metric-panel="0"');
    data.cases.push({ id: 'revealed-test', split: 'test' });
    expect(renderCockpit(data, 'n')).toContain('train 1 · validation 1 · test 1');
  });
});


it('keeps the mobile plot readable by scrolling its pane instead of shrinking the SVG', () => {
  const page = renderCockpit(viewerFixture(), 'n');
  const mobile = page.slice(page.indexOf('@media (max-width: 600px)'));
  expect(mobile).toContain('.chart-wrap { flex: none; height: 140px; min-height: 140px; }');
  expect(mobile).toContain('.view-pane[data-view-pane="overview"] { overflow: auto; }');
  expect(mobile).toContain('.convergence-panel .panel-body { flex: none; min-height: min-content; }');
  expect(mobile).toContain('height: auto; min-height: 100%; gap: 16px; grid-template-rows: max-content max-content minmax(145px, 1fr)');
});

it('assigns overflow to data panels while fixing the viewport and navigation', () => {
  const page = renderCockpit(viewerFixture(), 'n');
  expect(page).toContain('html, body { margin: 0; height: 100vh; height: 100dvh; overflow: hidden; }');
  expect(page).toMatch(/\.shell \{\s*height: 100vh;\s*height: 100dvh;\s*overflow: hidden;/);
  expect(page).toMatch(/\.sidebar \{[^}]*min-height: 0;\s*overflow: hidden;/);
  expect(page).toContain('.sidebar > section { min-height: 72px; flex: 1 1 0; overflow: auto; }');
  expect(page).toContain('.sidebar > nav { flex-shrink: 0; }');
  expect(page).toContain('.sidebar > nav > .panel-body { overflow: visible; gap: 6px; }');
  expect(page).toMatch(/\.outcome-title \{[^}]*font-size: var\(--font-heading\);/);
  for (const [role, size] of [['control', 12], ['body', 13], ['heading', 16], ['metric', 24]]) {
    expect(page).toContain(`--font-${role}: ${size}px;`);
  }
  expect(page).not.toMatch(/font-size:\s*(?:\d|clamp\()/);
  expect(page).toContain('.sidebar .nav-item { padding: 4px; font-size: var(--font-control); }');
});
