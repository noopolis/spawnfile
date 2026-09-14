import { afterEach, expect, it } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { cliFixture, datasetText } from '../fixture.js';
import { main } from '../commands.js';
import { loadInvocationViewer } from '../viewer.js';
import { openExperimentStore } from '../../storage/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('resumes interrupted real DSPy training from YAML without repeating settled native work', async () => {
  const f = await cliFixture(); roots.push(f.root);
  await writeFile(join(f.root, 'train.paideia.yaml'), `${datasetText([{ id: 'train', group: 'a' }, { id: 'selection', group: 'b' }])}
training:
  models:
    reflection: { provider: grok-subscription, model: reflection }
  optimizer: { model: reflection }
  budget: { max_trials: 8, max_proposals: 1, timeout_ms: 20000 }
  recovery: { max_attempts: 2 }
  validation_groups: [b]
  test: test.paideia.yaml
`);
  await writeFile(join(f.root, 'test.paideia.yaml'), datasetText([{ id: 'sealed', group: 'sealed' }]));
  const bridgeContexts: unknown[] = [];
  f.dependencies.spawnfile = { id: 'identity-test', version: '1', executionIdentity(context) {
    bridgeContexts.push(context); return 'fixed-test-environment';
  }, createAdapter() { throw new Error('Unused native project adapter'); },
  async prepareEnvironment() { throw new Error('Unused native project preparation'); } };
  const argv = ['train', '--train', 'train.paideia.yaml', ...f.nativeArgs, '--editable', 'AGENTS.md',
    '--bridge-command', relative(f.root, f.bridge), '--view', '0'];
  let optimizerCalls = 0;
  const reflection = f.dependencies.inference!(20000);
  f.dependencies.modelInference = () => ({ ...reflection, async generate(request) {
    optimizerCalls++;
    return reflection.generate(request);
  } });
  const controller = new AbortController();
  const first = await main(argv, { ...f.io, signal: controller.signal, stdout(text) {
    f.stdout.push(text);
    if (JSON.parse(text).type === 'trial.finished') controller.abort();
  } }, f.dependencies);
  expect(first).toBe(130);
  expect(bridgeContexts[0]).toMatchObject({ bridge: { command: f.bridge, cwd: f.root } });
  expect(f.observedInstructions).toHaveLength(1);
  const firstIndex = JSON.parse(await readFile(join(f.root, 'out/invocation.json'), 'utf8'));
  expect(firstIndex.outcome).toBe('failed');
  f.stderr.length = 0;
  const resumed = await main([...argv, '--resume'], f.io, f.dependencies);
  expect(f.stderr).toEqual([]);
  expect(resumed).toBe(0);
  const index = JSON.parse(await readFile(join(f.root, 'out/invocation.json'), 'utf8'));
  expect(index.summaryRunId).not.toBe(firstIndex.summaryRunId);
  const store = await openExperimentStore(join(f.root, 'out'));
  const report = JSON.parse((await store.readBlob(index.report, { audience: 'operator', phase: 'test',
    frozenCandidateIds: [index.candidateId] })).toString());
  expect(report.trials).toHaveLength(f.observedInstructions.length);
  expect(report.trials.some((trial: { id: string }) => trial.id === firstIndex.trialIds[0])).toBe(true);
  expect(report.optimizer.provenance.optimizer).toBe('dspy.GEPA');
  expect(report.heldOut.map((entry: { meanScore: number }) => entry.meanScore)).toEqual([0, 1]);
  const nativeCalls = f.observedInstructions.length, generations = optimizerCalls;
  expect(await main([...argv, '--resume'], f.io, f.dependencies)).toBe(0);
  expect(f.observedInstructions).toHaveLength(nativeCalls);
  expect(optimizerCalls).toBe(generations);
  const view = await (await loadInvocationViewer(join(f.root, 'out')))();
  expect(view.trials).toHaveLength(nativeCalls);
  expect(view.costs?.observed?.groups.find(group => group.role === 'subject')?.entryCount).toBe(nativeCalls);
  expect(view.costs?.observed?.groups.find(group => group.role === 'optimizer')?.entryCount).toBe(generations);
}, 60000);
