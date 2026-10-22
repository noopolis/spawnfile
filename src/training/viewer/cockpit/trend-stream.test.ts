import { expect, it } from 'vitest';
import { startViewer } from '../index.js';
import { viewerFixture } from '../fixture.js';

it('a real SSE revision refreshes trial SVG geometry even when candidate identity stays unchanged', async () => {
  const data = viewerFixture();
  data.trials[0]!.checks = [];
  const server = await startViewer({ load: async () => data });
  const controller = new AbortController();
  try {
    const response = await fetch(`${server.url}/api/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const firstEvent = new TextDecoder().decode((await reader.read()).value);
    expect(firstEvent).toContain('event: snapshot');
    const before = await (await fetch(server.url)).text();
    expect(before.match(/class="chart-point /g)).toHaveLength(1);
    data.trials.push({ ...data.trials[0]!, id: 'trial-2', score: 0.9 });
    const nextEvent = new TextDecoder().decode((await reader.read()).value);
    expect(nextEvent).toContain('event: snapshot');
    expect(nextEvent).not.toBe(firstEvent);
    const after = await (await fetch(server.url)).text();
    expect(after.match(/class="chart-point /g)).toHaveLength(2);
    expect(after).toContain('class="chart-train" x1="8%" y1="47%" x2="91%" y2="19%"');
    expect(after).toContain('Development trial 2, train, Baseline (baseline), train: 90 / 100');
    expect(after).toContain('Trial order on x-axis; cases may differ');
    await reader.cancel();
  } finally { controller.abort(); await server.close(); }
});
