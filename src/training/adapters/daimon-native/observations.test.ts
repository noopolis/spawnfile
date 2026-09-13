import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Observation } from '../../contracts/execution.js';
import { aggregateUsage, createNativeObserver } from './observations.js';
import { launchFixture } from './test-fixtures.js';
import type { NativeUsage, TerminalEvidence } from './worker/index.js';

test('receipt observations preserve errors/results and deduplicate actual action identity', async () => {
  const fixture = await launchFixture();
  try {
    const home = join(fixture.input.runtimeHomePath, 'native/home');
    const directory = join(home, 'tool-state'); await mkdir(directory);
    const events: Observation[] = []; fixture.input.onObservation = event => { events.push(event); };
    const receipts = [
      { kind: 'mcp', server: 'newsroom', tool: 'file_article', is_error: false, result: { details: { accepted: true } } },
      { kind: 'mcp', server: 'newsroom', tool: 'file_article', is_error: true, error: 'Headline required' },
      { kind: 'moltnet', message_id: 'message-1' },
    ];
    for (const [index, row] of receipts.entries()) await writeFile(join(directory, `${String(index).repeat(64)}.json`), JSON.stringify({
      ...row, agent_id: 'agent:writer', engine: 'codex', delivery_id: `action-${index}`, at: new Date().toISOString() }));
    const observer = createNativeObserver(fixture.input, home, fixture.launch.agent.id);
    await observer.checkpoint('wake'); await observer.checkpoint('wake');
    assert.equal(events.length, 3);
    assert.equal(events[1]?.success, false);
    assert.equal(events[1]?.result, 'Headline required');
    assert.equal(events[2]?.tool, 'moltnet_send');
    assert.ok(events.every(event => event.args === undefined && event.type === 'tool.complete'));
    const usage = await observer.terminal('wake', { status: 'failed', completedAt: new Date().toISOString(), native: { usage: [] } } as unknown as TerminalEvidence);
    assert.equal(usage, null);
    assert.equal(events.at(-1)?.type, 'diagnostic');
    assert.throws(() => aggregateUsage([{ input: Number.MAX_SAFE_INTEGER, output: 0, cache_read: 0 },
      { input: 1, output: 0, cache_read: 0 }] as NativeUsage[]), /aggregate/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
