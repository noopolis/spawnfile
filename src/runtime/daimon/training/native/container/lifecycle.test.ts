import assert from 'node:assert/strict';
import { test } from 'vitest';
import { rm } from 'node:fs/promises';
import { startOwnedContainer } from './lifecycle.js';
import { createContainerArguments } from './docker.js';
import { dockerFixture, launchFixture } from '../test-fixtures.js';

test('container boundary is isolated and stop verifies absence after killing remaining cognition', async () => {
  const fixture = await launchFixture();
  try {
    const args = createContainerArguments(fixture.launch, 'unit-name', 'unit-owner', 'trial', 1000);
    assert.ok(args.includes('--read-only'));
    assert.ok(args.includes('--user'));
    assert.ok(args.includes('no-new-privileges'));
    assert.ok(!args.includes('--privileged') && !args.includes('--network=host'));
    const docker = dockerFixture(fixture.launch, fixture.input.trialId);
    docker.requireKill();
    const container = await startOwnedContainer(docker.run, fixture.launch, fixture.input.trialId, 1000);
    const receipt = await container.stop('Unit lifecycle end');
    assert.equal(receipt.quiescence, 'confirmed');
    const operations = docker.calls.map(args => args[0]);
    assert.ok(operations.indexOf('kill') > operations.indexOf('stop'));
    assert.ok(operations.indexOf('rm') > operations.indexOf('kill'));
    assert.equal(operations.at(-1), 'inspect');
    assert.deepEqual(await container.stop('Same shutdown'), receipt);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('ownership mismatch refuses termination and cannot claim quiescence', async () => {
  const fixture = await launchFixture();
  try {
    const docker = dockerFixture(fixture.launch, fixture.input.trialId);
    const container = await startOwnedContainer(docker.run, fixture.launch, fixture.input.trialId, 1000);
    docker.forgeOwner();
    const receipt = await container.stop('Refuse foreign container');
    assert.equal(receipt.state, 'unknown');
    assert.equal(receipt.quiescence, 'unknown');
    assert.ok(!docker.calls.some(args => ['stop', 'kill', 'rm'].includes(args[0]!)));
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
