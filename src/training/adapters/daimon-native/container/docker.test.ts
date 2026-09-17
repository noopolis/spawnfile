import assert from 'node:assert/strict';
import { test } from 'vitest';
import { dockerCommand, inspectOwned, workerRequest, ownerLabel, type DockerCommand } from './docker.js';
import { createContainerArguments } from './docker.js';
import { launchFixture } from '../test-fixtures.js';
import { grokLaunchFrom } from '../grok-fixtures.js';
import { containerSecurityOptions } from './preflight.js';
import { rm } from 'node:fs/promises';

test('process driver records actual exit/output and bounds cancellation and diagnostics', async () => {
  const run = dockerCommand(process.execPath);
  const result = await run(['-e', 'process.stdin.on("data",v=>process.stdout.write(v));process.stderr.write("diagnostic")'], { stdin: 'payload' });
  assert.equal(result.stdout, 'payload');
  assert.equal(result.stderr, 'diagnostic');
  assert.equal(result.code, 0);
  assert.equal((await run(['-e', 'process.exitCode=7'])).code, 7);
  await assert.rejects(dockerCommand('/nonexistent-unit-executable')([]), /ENOENT/);
  await assert.rejects(run([], { signal: AbortSignal.abort() }), /aborted/);
  const cancellation = new AbortController();
  const pending = run(['-e', 'setInterval(()=>{},1000)'], { signal: cancellation.signal });
  setTimeout(() => cancellation.abort(), 30);
  await assert.rejects(pending, /aborted/);
  await assert.rejects(run(['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 20 }), /deadline/);
  await assert.rejects(run(['-e', 'process.stderr.write("x".repeat(70000));setInterval(()=>{},1000)']), /diagnostics exceeded/);
  await assert.rejects(run(['-e', 'process.stdout.write("x".repeat(17000000));setInterval(()=>{},1000)']), /output exceeded/);
});

test('native request and ownership readers reject failed or foreign evidence', async () => {
  const absent: DockerCommand = async () => ({ code: 1, stdout: '', stderr: 'No such container' });
  assert.equal(await inspectOwned(absent, 'unit', 'owner'), undefined);
  const failed: DockerCommand = async () => ({ code: 1, stdout: '', stderr: 'permission denied' });
  await assert.rejects(inspectOwned(failed, 'unit', 'owner'), /Cannot inspect/);
  await assert.rejects(workerRequest(failed, 'unit', '/trial/health'), /request failed/);
  const malformed: DockerCommand = async () => ({ code: 0, stdout: JSON.stringify({ Config: { Labels: { [ownerLabel]: 'owner' } }, State: {} }), stderr: '' });
  await assert.rejects(inspectOwned(malformed, 'unit', 'owner'), /ownership or state/);
  const brokenJson: DockerCommand = async () => ({ code: 0, stdout: '{', stderr: '' });
  await assert.rejects(workerRequest(brokenJson, 'unit', '/trial/health'));
});

test('container startup selects the declared bootstrap or the packaged worker and kills a TERM-resistant child', async () => {
  const f = await launchFixture();
  try {
    assert.ok(createContainerArguments(f.launch, 'n', 'o', 't', 1000).includes('/opt/paideia/bootstrap/bootstrap.js'));
    delete f.launch.bootstrap;
    assert.ok(createContainerArguments(f.launch, 'n', 'o', 't', 1000, '1000:1000').includes('/opt/paideia/native/worker/cli.js'));
    await assert.rejects(dockerCommand(process.execPath)(['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { timeoutMs: 200 }), /deadline/);
    await assert.rejects(dockerCommand(process.execPath)(['-e', 'process.stdin.destroy();setInterval(()=>{},1000)'],
      { timeoutMs: 200, stdin: 'x'.repeat(4_000_000) }), /deadline/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('Codex-only outer security options never reach a Grok launch, which cannot use a separate container', async () => {
  const f = await launchFixture();
  try {
    assert.deepEqual(containerSecurityOptions(f.launch), ['--security-opt', 'seccomp=unconfined', '--security-opt', 'apparmor=unconfined']);
    assert.ok(createContainerArguments(f.launch, 'n', 'o', 't', 1000).includes('seccomp=unconfined'));
    const grok = await grokLaunchFrom(f.launch, f.root);
    assert.throws(() => containerSecurityOptions(grok), /Separate-container Grok/);
    assert.throws(() => createContainerArguments(grok, 'n', 'o', 't', 1000), /child-process execution/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
