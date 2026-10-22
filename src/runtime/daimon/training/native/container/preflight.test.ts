import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'vitest';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { createContainerArguments, type DockerCommand } from './docker.js';
import { startOwnedContainer } from './lifecycle.js';
import { codexSandboxContainerSecurity, sandboxChecks, sandboxNetworkProbeScript, sandboxPreflightSchema, verifyNativeSandbox } from './preflight.js';
import { dockerFixture, launchFixture, writeSandboxProjectionFixture } from '../test-fixtures.js';

const proof = { schema: sandboxPreflightSchema, modelCallsMade: 0, checks: Object.fromEntries(sandboxChecks.map(key => [key, true])) };

test('the actual emitted network probe fails closed on timeout and never recovers after connection', () => {
  for (const events of [['error'], ['timeout'], ['timeout', 'error'], ['connect', 'error'], ['connect', 'timeout', 'error']]) {
    const socket = Object.assign(new EventEmitter(), { destroy: () => undefined,
      setTimeout: (_ms: number, listener: () => void) => socket.once('timeout', listener) });
    const written: string[] = [];
    const process = { exitCode: 0, stderr: { write: (_message: string) => undefined } };
    runInNewContext(sandboxNetworkProbeScript, { net: { connect: () => socket }, port: 1234, process,
      fs: { writeFileSync: (path: string, text: string) => written.push(`${path}:${text}`) } });
    for (const event of events) socket.emit(event);
    assert.deepEqual(written, events[0] === 'error' ? ['complete:SANDBOX_CHECKS_PASSED'] : []);
    assert.equal(process.exitCode, events[0] === 'error' ? 0 : 1);
  }
});

test('native container permits the nested sandbox while retaining outer privilege restrictions', async () => {
  const f = await launchFixture();
  try {
    const args = createContainerArguments(f.launch, 'name', 'owner', 'trial', 1000, '501:20');
    assert.ok(args.join(' ').includes(codexSandboxContainerSecurity.join(' ')));
    assert.ok(args.join(' ').includes('--cap-drop ALL --security-opt no-new-privileges'));
    assert.ok(args.includes('--read-only'));
    assert.ok(args.join(' ').includes('--user 501:20'));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('preflight requires explicit zero-call enforcement evidence and saves a bound receipt', async () => {
  const f = await launchFixture();
  try {
    const signal = new AbortController().signal;
    await writeSandboxProjectionFixture(f.launch, f.input.trialId);
    const run: DockerCommand = async (args, options) => {
      assert.deepEqual(args.slice(0, 4), ['exec', '-i', 'container', '/usr/local/bin/node']);
      assert.equal(options?.signal, signal);
      const request = JSON.parse(options!.stdin!);
      if (request.path === 'native-policy-preflight') return { code: 0, stdout: JSON.stringify({ schema: 'paideia.daimon-native.policy-preflight.v1',
        projectionSha256: request.projectionSha256, modelCallsMade: 0, workspaceReadWrite: true }), stderr: '' };
      assert.equal(options?.timeoutMs, 25_000);
      assert.equal(request.workspace, f.launch.workspace.target);
      return { code: 0, stdout: JSON.stringify(proof), stderr: '' };
    };
    await verifyNativeSandbox(run, 'container', f.launch, f.input.trialId, signal);
    const saved = JSON.parse(await readFile(join(dirname(f.launch.receiptFile), 'sandbox-preflight.json'), 'utf8'));
    assert.equal(saved.trialId, f.input.trialId);
    assert.equal(saved.configSha256, f.launch.configSha256);
    assert.equal(saved.image, f.launch.image);
    assert.deepEqual(saved.checks, proof.checks);
    assert.deepEqual(saved.outerCompatibility, [...codexSandboxContainerSecurity]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('failed, empty and incomplete probes reject startup and clean the container before any wake', async () => {
  const f = await launchFixture();
  try {
    for (const response of [
      { code: 1, stdout: '', stderr: 'bwrap namespace denied' },
      { code: 0, stdout: '', stderr: '' },
      ...[{ ...proof, schema: 'other' }, { ...proof, modelCallsMade: 1 }, { ...proof, checks: {} },
        { ...proof, checks: { ...proof.checks, authDenied: false } }].map(value => ({ code: 0, stdout: JSON.stringify(value), stderr: '' })),
    ]) {
      const docker = dockerFixture(f.launch, f.input.trialId);
      let preflights = 0; let wakes = 0;
      const run: DockerCommand = async (args, options) => {
        if (options?.stdin?.includes('sandbox-preflight')) { preflights++; return response; }
        if (options?.stdin?.includes('/trial/run')) wakes++;
        return docker.run(args, options);
      };
      await assert.rejects(startOwnedContainer(run, f.launch, f.input.trialId, 1000));
      assert.equal(preflights, 1);
      assert.equal(wakes, 0);
      assert.ok(docker.calls.some(args => args[0] === 'rm'));
      await assert.rejects(readFile(join(dirname(f.launch.receiptFile), 'sandbox-preflight.json')), /ENOENT/);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
