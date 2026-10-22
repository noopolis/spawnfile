import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { verifyPreparedNativeSandbox } from './native-preflight.js';
import { dockerFixture, launchFixture, writeSandboxProjectionFixture } from '../test-fixtures.js';
import type { DockerCommand } from './docker.js';
import { startOwnedContainer } from './lifecycle.js';

test('exact native projection is required, validated and forwarded unchanged to the mechanical command', async () => {
  const f = await launchFixture();
  try {
    const run = dockerFixture(f.launch, f.input.trialId).run;
    await assert.rejects(verifyPreparedNativeSandbox(run, 'unit', f.launch, f.input.trialId), /ENOENT/);
    await writeSandboxProjectionFixture(f.launch, f.input.trialId);
    const path = join(f.launch.controlRoot, 'sandbox-projection.json');
    const bound = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...bound, trialId: 'foreign' }));
    await assert.rejects(verifyPreparedNativeSandbox(run, 'unit', f.launch, f.input.trialId), /not bound/);
    await writeFile(path, JSON.stringify(bound));
    const forward: DockerCommand = async (args, options) => {
      const sent = JSON.parse(options!.stdin!);
      assert.deepEqual(sent.projection, bound.projection);
      assert.equal(sent.projectionSha256, bound.projectionSha256);
      return run(args, options);
    };
    assert.deepEqual(await verifyPreparedNativeSandbox(forward, 'unit', f.launch, f.input.trialId),
      { projectionSha256: bound.projectionSha256, workspaceReadWrite: true });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('failed exact native policy or unbound success never admits a wake and reaps the container', async () => {
  const f = await launchFixture();
  try {
    for (const failure of ['bwrap', 'empty', 'schema', 'digest', 'calls', 'write']) {
      const docker = dockerFixture(f.launch, f.input.trialId);
      const run: DockerCommand = async (args, options) => {
        const result = await docker.run(args, options);
        if (!options?.stdin?.includes('native-policy-preflight')) return result;
        if (failure === 'bwrap') return { code: 1, stdout: '', stderr: "bwrap: Can't mkdir parents for /run/paideia/control: Read-only file system" };
        if (failure === 'empty') return { code: 0, stdout: '', stderr: '' };
        const value = JSON.parse(result.stdout);
        if (failure === 'schema') value.schema = 'other';
        if (failure === 'digest') value.projectionSha256 = 'f'.repeat(64);
        if (failure === 'calls') value.modelCallsMade = 1;
        if (failure === 'write') value.workspaceReadWrite = false;
        return { ...result, stdout: JSON.stringify(value) };
      };
      await assert.rejects(startOwnedContainer(run, f.launch, f.input.trialId, 1000));
      assert.ok(docker.calls.some(args => args[0] === 'rm'));
      assert.ok(!docker.calls.some(args => args.includes('/trial/run')));
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
