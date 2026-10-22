import assert from 'node:assert/strict';
import { test } from 'vitest';
import { rm } from 'node:fs/promises';
import { createDaimonNativeAdapter } from './adapter.js';
import { dockerFixture, launchFixture } from './test-fixtures.js';
import type { DockerCommand } from './container/index.js';

test('already aborted subjects never launch and cancellation stops an existing owned container', async () => {
  const fixture = await launchFixture();
  try {
    for (const timeoutMs of [0, 99, 100.5, Infinity, NaN, 86_400_001]) {
      assert.throws(() => createDaimonNativeAdapter({ timeoutMs }), /deadline/);
    }
    const docker = dockerFixture(fixture.launch, fixture.input.trialId);
    const adapter = createDaimonNativeAdapter({ docker: docker.run, timeoutMs: 1000 });
    await assert.rejects(adapter.start({ ...fixture.input, signal: AbortSignal.abort() }), /aborted/);
    assert.equal(docker.calls.length, 0);
    const cancelled = new AbortController();
    const run: DockerCommand = async (args, options) => {
      if (args[0] === 'exec' && options?.stdin?.includes('/trial/run')) {
        setTimeout(() => cancelled.abort(), 5);
        return new Promise((_, reject) => options.signal?.addEventListener('abort', () => reject(new Error('HTTP cancelled')), { once: true }));
      }
      return docker.run(args, options);
    };
    const session = await createDaimonNativeAdapter({ docker: run, timeoutMs: 1000 }).start(fixture.input);
    const result = await session.run({ id: 'task', text: 'Work' }, cancelled.signal);
    assert.equal(result.status, 'cancelled');
    assert.equal(result.stop?.quiescence, 'confirmed');
    await assert.rejects(session.run({ id: 'next', text: 'No second delivery' }), /one delivery/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('failed observation persistence cancels the owned container instead of claiming a complete trial', async () => {
  const fixture = await launchFixture();
  try {
    const docker = dockerFixture(fixture.launch, fixture.input.trialId);
    docker.setTerminal({ schema: 'paideia.daimon-native.trial.v1', trialId: fixture.input.trialId, wakeId: 'task',
      agentId: 'agent:writer', model: 'test-model-v1', configSha256: fixture.launch.configSha256, status: 'failed',
      completedAt: new Date().toISOString(), native: { usage: [] }, coverage: [] });
    fixture.input.onObservation = () => { throw new Error('Evidence persistence unavailable'); };
    const session = await createDaimonNativeAdapter({ docker: docker.run, timeoutMs: 1000 }).start(fixture.input);
    const result = await session.run({ id: 'task', text: 'Work' });
    assert.equal(result.status, 'failed'); assert.match(result.error!, /persistence/);
    assert.equal(result.stop?.quiescence, 'confirmed');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
