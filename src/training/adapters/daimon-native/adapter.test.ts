import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createDaimonNativeAdapter } from './adapter.js';
import { dockerFixture, launchFixture } from './test-fixtures.js';
import { join } from 'node:path';
import type { Observation } from '../../contracts/execution.js';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { parseWorkerArguments, type TerminalEvidence } from './worker/index.js';
import { createNativeHttpClient } from './transport/index.js';

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

test.each([7_200_000, 86_400_000])('forwards a %i ms trial through worker arguments and HTTP with cleanup grace', async timeoutMs => {
  const fixture = await launchFixture();
  const previous = getGlobalDispatcher();
  const http = new MockAgent(); http.disableNetConnect(); setGlobalDispatcher(http);
  http.get('http://native-worker.test').intercept({ path: '/trial/run', method: 'POST' }).reply(() => {
    const terminal: TerminalEvidence = { schema: 'paideia.daimon-native.trial.v1', trialId: fixture.input.trialId, wakeId: 'task',
      agentId: fixture.launch.agent.id, model: fixture.launch.agent.model, configSha256: fixture.launch.configSha256,
      status: 'completed', scheduleOverride: 'disabled', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      native: { traces: [], toolReceipts: [], modelContexts: [], usage: [] }, coverage: [] };
    return { statusCode: 200, data: JSON.stringify(terminal), responseOptions: { headers: { 'content-type': 'application/json' } } };
  });
  try {
    const request = createNativeHttpClient('http://native-worker.test', 'unit-control-token-not-an-auth-login');
    const docker = dockerFixture(fixture.launch, fixture.input.trialId);
    let workerTimeout: number | undefined;
    let httpTimeout: number | undefined;
    const session = await createDaimonNativeAdapter({ timeoutMs, docker: async (args, options) => {
      if (args[0] === 'create') workerTimeout = parseWorkerArguments(args.slice(args.indexOf('--launch'))).timeoutMs;
      if (args[0] === 'exec' && options?.stdin) {
        const input = JSON.parse(options.stdin);
        if (input.path === '/trial/run') {
          httpTimeout = input.timeoutMs as number;
          const terminal = await request(input.path, input.body, httpTimeout, options.signal);
          return { code: 0, stdout: JSON.stringify(terminal), stderr: '' };
        }
      }
      return docker.run(args, options);
    } }).start(fixture.input);
    try {
      assert.equal((await session.run({ id: 'task', text: 'Assigned article' })).status, 'completed');
      assert.equal(workerTimeout, timeoutMs);
      assert.ok(httpTimeout! > timeoutMs && httpTimeout! <= timeoutMs + 8000);
    } finally { assert.equal((await session.stop('Deadline propagation checked')).quiescence, 'confirmed'); }
    http.assertNoPendingInterceptors();
  } finally {
    setGlobalDispatcher(previous); await http.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});


test('admits native skills as prepared workspace files without inventing loaded observations', async () => {
  const fixture = await launchFixture();
  try {
    for (const root of ['.agents/skills', '.codex/skills']) {
      const folder = join(fixture.input.workspacePath, root, 'writer');
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, 'SKILL.md'), '---\nname: writer\ndescription: Writing\n---\nWrite.');
    }
    const docker = dockerFixture(fixture.launch, fixture.input.trialId);
    const adapter = createDaimonNativeAdapter({ docker: docker.run });
    assert.ok(adapter.capabilities.resources.includes('native-skills'));
    const events: Observation[] = []; fixture.input.onObservation = event => { events.push(event); };
    const session = await adapter.start(fixture.input);
    assert.match(await readFile(join(fixture.input.workspacePath, '.codex/skills/writer/SKILL.md'), 'utf8'), /name: writer/);
    assert.equal(events.length, 0);
    await session.stop('Installed skill admission checked; no cognition claimed');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
