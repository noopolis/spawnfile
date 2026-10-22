import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { startOwnedContainer } from './lifecycle.js';
import { dockerFixture, launchFixture } from '../test-fixtures.js';
import type { DockerCommand } from './docker.js';

test('failed startup cleans actual created side effects and rejects unavailable readiness', async () => {
  const fixture = await launchFixture();
  try {
    for (const failing of ['create-response', 'start', 'early-exit', 'health', 'remote-context']) {
      await rm(join(dirname(fixture.launch.receiptFile), 'sandbox-preflight.json'), { force: true });
      const docker = dockerFixture(fixture.launch, fixture.input.trialId);
      const run: DockerCommand = async (args, options) => {
        const result = await docker.run(args, options);
        if (failing === 'create-response' && args[0] === 'create') throw new Error('Lost Docker create response');
        if (failing === 'start' && args[0] === 'start') return { code: 1, stdout: '', stderr: 'start failed' };
        if (failing === 'early-exit' && args[0] === 'start') await docker.run(['stop', 'unit']);
        if (failing === 'health' && args[0] === 'exec' && options?.stdin?.includes('/trial/health')) throw new Error('Not ready');
        if (failing === 'remote-context' && args[0] === 'context') return { code: 0, stdout: '"ssh://remote"', stderr: '' };
        return result;
      };
      await assert.rejects(startOwnedContainer(run, fixture.launch, fixture.input.trialId, 1000, undefined, 1));
      assert.equal(docker.calls.some(args => args[0] === 'rm'), failing !== 'remote-context');
    }
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('lost containers, false remove success and unkillable executions cannot bypass containment checks', async () => {
  const fixture = await launchFixture();
  try {
    for (const mode of ['gone', 'false-remove', 'still-running', 'startup-and-cleanup']) {
      await rm(join(dirname(fixture.launch.receiptFile), 'sandbox-preflight.json'), { force: true });
      const docker = dockerFixture(fixture.launch, fixture.input.trialId);
      let stopping = false;
      const run: DockerCommand = async (args, options) => {
        if (mode === 'startup-and-cleanup' && args[0] === 'start') { docker.forgeOwner(); return { code: 1, stdout: '', stderr: 'failed start' }; }
        if (mode === 'gone' && stopping && args[0] === 'inspect') return { code: 1, stdout: '', stderr: 'No such container' };
        if (mode === 'false-remove' && args[0] === 'rm') return { code: 0, stdout: '', stderr: '' };
        if (mode === 'still-running' && ['stop', 'kill'].includes(args[0]!)) return { code: 0, stdout: '', stderr: '' };
        return docker.run(args, options);
      };
      if (mode === 'startup-and-cleanup') { await assert.rejects(startOwnedContainer(run, fixture.launch, fixture.input.trialId, 1000), /unconfirmed/); continue; }
      const container = await startOwnedContainer(run, fixture.launch, fixture.input.trialId, 1000);
      stopping = true;
      if (mode === 'still-running') vi.useFakeTimers();
      const pending = container.stop('Check actual owned state');
      if (mode === 'still-running') await vi.advanceTimersByTimeAsync(3200);
      assert.equal((await pending).quiescence, mode === 'gone' ? 'confirmed' : 'unknown');
      vi.useRealTimers();
    }
  } finally { vi.useRealTimers(); await rm(fixture.root, { recursive: true, force: true }); }
});

test('bad creation receipts and startup cancellation still clean owned side effects', async () => {
  const f = await launchFixture(); const priorHost = process.env['DOCKER_HOST'];
  try {
    process.env['DOCKER_HOST'] = 'ssh://remote';
    await assert.rejects(startOwnedContainer(dockerFixture(f.launch, f.input.trialId).run, f.launch, f.input.trialId, 1000), /local Docker/);
    delete process.env['DOCKER_HOST'];
    for (const mode of ['create-error', 'cancel']) {
      const docker = dockerFixture(f.launch, f.input.trialId); const cancelled = new AbortController();
      const run: DockerCommand = async (args, options) => {
        const result = await docker.run(args, options);
        if (mode === 'create-error' && args[0] === 'create') return { code: 1, stdout: 'not-a-container-id', stderr: 'failed' };
        if (mode === 'cancel' && args[0] === 'start') cancelled.abort();
        return result;
      };
      await assert.rejects(startOwnedContainer(run, f.launch, f.input.trialId, 1000, cancelled.signal));
    }
  } finally { if (priorHost === undefined) delete process.env['DOCKER_HOST']; else process.env['DOCKER_HOST'] = priorHost; await rm(f.root, { recursive: true, force: true }); }
});

test('shutdown fallbacks handle unavailable native stop and surface failed containment', async () => {
  const fixture = await launchFixture();
  try {
    for (const failing of ['native-stop', 'docker-stop', 'remove', 'kill']) {
      await rm(join(dirname(fixture.launch.receiptFile), 'sandbox-preflight.json'), { force: true });
      const docker = dockerFixture(fixture.launch, fixture.input.trialId);
      if (failing === 'kill') docker.requireKill();
      const run: DockerCommand = async (args, options) => {
        if (failing === 'native-stop' && args[0] === 'exec' && options?.stdin?.includes('/trial/stop')) throw new Error('Native stop unavailable');
        if (failing === 'docker-stop' && args[0] === 'stop') throw new Error('Docker stop unavailable');
        if (failing === 'remove' && args[0] === 'rm') return { code: 1, stdout: '', stderr: 'remove refused' };
        if (failing === 'kill' && args[0] === 'kill') throw new Error('Kill refused');
        return docker.run(args, options);
      };
      const container = await startOwnedContainer(run, fixture.launch, fixture.input.trialId, 1000);
      const receipt = await container.stop('Exercise actual cleanup branch');
      assert.equal(receipt.quiescence, ['remove', 'kill'].includes(failing) ? 'unknown' : 'confirmed');
    }
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
