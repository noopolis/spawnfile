import assert from 'node:assert/strict';
import { test } from 'vitest';
import { rm } from 'node:fs/promises';
import { createDaimonNativeAdapter } from './adapter.js';
import { dockerFixture, launchFixture } from './test-fixtures.js';
import type { Observation } from '../../contracts/execution.js';

test('adapter preserves terminal identity and actual usage while keeping unavailable output absent', async () => {
  const fixture = await launchFixture();
  try {
    const docker = dockerFixture(fixture.launch, fixture.input.trialId);
    const events: Observation[] = [];
    fixture.input.onObservation = event => { events.push(event); };
    docker.setTerminal({ schema: 'paideia.daimon-native.trial.v1', trialId: fixture.input.trialId, wakeId: 'task',
      agentId: 'agent:writer', model: 'test-model-v1', configSha256: fixture.launch.configSha256, status: 'completed',
      completedAt: new Date().toISOString(), native: { traces: [], toolReceipts: [], modelContexts: [], usage: [{ input: 100, output: 20, cache_read: 40 }] },
      coverage: [{ channel: 'output', completeness: 'absent', ordering: 'none' }, { channel: 'usage', completeness: 'partial', ordering: 'source' }] });
    const adapter = createDaimonNativeAdapter({ docker: docker.run, timeoutMs: 1000 });
    const session = await adapter.start(fixture.input);
    const result = await session.run({ id: 'task', text: 'Assigned article' });
    assert.equal(result.status, 'completed');
    assert.equal(result.text, '');
    assert.equal(result.usage?.inputTokens, 100);
    assert.equal(events.some(event => event.type === 'tool.dispatch'), false);
    assert.equal(events.some(event => event.type === 'output'), false);
    assert.equal((await session.stop('End unit trial')).quiescence, 'confirmed');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('adapter rejects a terminal record from another trial and shuts down its owned container', async () => {
  const fixture = await launchFixture();
  try {
    const docker = dockerFixture(fixture.launch, fixture.input.trialId);
    docker.setTerminal({ schema: 'paideia.daimon-native.trial.v1', trialId: 'foreign' });
    const session = await createDaimonNativeAdapter({ docker: docker.run, timeoutMs: 1000 }).start(fixture.input);
    const result = await session.run({ id: 'task', text: 'Assigned article' });
    assert.equal(result.status, 'failed');
    assert.match(result.error!, /identity mismatch/);
    assert.equal(result.stop?.quiescence, 'confirmed');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
