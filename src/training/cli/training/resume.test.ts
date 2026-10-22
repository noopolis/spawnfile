import * as providerPolicies from '../../contracts/inference-policy.js';
import { afterEach, expect, it, vi } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { cliFixture, datasetText } from '../fixture.js';
import { main } from '../commands.js';
import { loadInvocationViewer } from '../viewer.js';
import type { InvocationIndex } from '../types.js';
import { openExperimentStore } from '../../storage/index.js';
import { trainingDigest } from '../../experiments/training/index.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

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
  const policies = providerPolicies.trainingInferencePolicies();
  const commandPolicy = vi.spyOn(providerPolicies, 'trainingInferencePolicies').mockReturnValue({ ...policies,
    optimizer: [{ provider: 'grok-subscription', policy: 'changed-isolation' }] });
  expect(await main([...argv, '--resume'], f.io, f.dependencies)).not.toBe(0);
  expect(f.stderr.join(' ')).toContain('Command checkpoint inputs changed');
  expect(f.observedInstructions).toHaveLength(1); expect(optimizerCalls).toBe(0);
  commandPolicy.mockRestore(); f.stderr.length = 0;
  const originalRoute = providerPolicies.trainingRoutePolicies;
  const optimizerPolicy = vi.spyOn(providerPolicies, 'trainingRoutePolicies').mockImplementation((config, route) =>
    originalRoute(config, route).map(value => ({ ...value, policy: `${value.policy}:changed` })));
  expect(await main([...argv, '--resume'], f.io, f.dependencies)).not.toBe(0);
  const failedStore = await openExperimentStore(join(f.root, 'out'));
  const failedIndex = JSON.parse(await readFile(join(f.root, 'out/invocation.json'), 'utf8'));
  const failure = JSON.parse((await failedStore.readBlob(failedIndex.report, { audience: 'operator', phase: 'replay' })).toString());
  const privateReplay = await failedStore.readReplay(failure.progressRunId, { audience: 'operator', phase: 'replay' });
  const diagnostic = privateReplay.events.find(event => event.id === failure.diagnosticId)!.payload as { diagnostic: InvocationIndex['report'] };
  expect((await failedStore.readBlob(diagnostic.diagnostic, { audience: 'operator', phase: 'replay' })).toString()).toContain('Training checkpoint identity or integrity mismatch');
  expect(f.observedInstructions).toHaveLength(1); expect(optimizerCalls).toBe(0);
  optimizerPolicy.mockRestore(); f.stderr.length = 0;
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

it('runs only missing held-out repeats after partial completion, including a settled unpublished checkpoint entry', async () => {
  const f = await cliFixture(); roots.push(f.root);
  await writeFile(join(f.root, 'train.yaml'), `${datasetText([{ id: 'train', group: 'a' }, { id: 'selection', group: 'b' }])}
training:
  models:
    reflection: { provider: grok-subscription, model: reflection }
  optimizer: { model: reflection }
  budget: { max_trials: 16, max_proposals: 1, test_repeats: 3, timeout_ms: 20000 }
  validation_groups: [b]
  test: test.yaml
`);
  await writeFile(join(f.root, 'test.yaml'), datasetText([{ id: 'sealed-a', group: 'sealed-a' }, { id: 'sealed-b', group: 'sealed-b' }]));
  f.dependencies.modelInference = () => f.dependencies.inference!(20000);
  const argv = ['train', '--train', 'train.yaml', ...f.nativeArgs, '--editable', 'AGENTS.md',
    '--bridge-command', relative(f.root, f.bridge)];
  const forbidden = () => { throw new Error('dry-run opened model'); };
  expect(await main([...argv, '--dry-run'], f.io, { adapter: forbidden, modelInference: forbidden })).toBe(0);
  const plan = JSON.parse(f.stdout.at(-1)!);
  expect(plan.budget).toMatchObject({ metricCalls: 4, reservedTestTrials: 12 });
  let finished = 0;
  const first = await main(argv, { ...f.io, stdout(text) {
    f.stdout.push(text);
    const event = JSON.parse(text);
    if (event.type === 'trial.finished' && event.phase === 'test' && ++finished === 2) throw new Error('controlled sealed interruption');
  } }, f.dependencies);
  expect(first).toBe(2); expect(finished).toBe(2);
  expect(f.observedInstructions).toHaveLength(6); // four optimizer trials + two sealed repeats
  const path = join(f.root, 'out/checkpoint/training.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  const sealed = Object.values(saved.state.entries).filter((entry: unknown) => (entry as { report: { phase: string } }).report.phase === 'test') as { id: string; report?: unknown }[];
  expect(sealed).toHaveLength(2); expect(sealed[0]!.id).not.toBe(sealed[1]!.id);
  // Model a crash after immutable publication but before checkpoint completion.
  delete sealed[1]!.report;
  saved.digest = trainingDigest(saved.state);
  await writeFile(path, JSON.stringify(saved));
  f.stderr.length = 0;
  expect(await main([...argv, '--resume'], f.io, f.dependencies)).toBe(0);
  expect(f.stderr).toEqual([]); expect(f.observedInstructions).toHaveLength(16);
  const index = JSON.parse(await readFile(join(f.root, 'out/invocation.json'), 'utf8'));
  const store = await openExperimentStore(join(f.root, 'out'));
  const report = JSON.parse((await store.readBlob(index.report, { audience: 'operator', phase: 'test', frozenCandidateIds: [index.candidateId] })).toString());
  const tests = report.trials.filter((trial: { phase: string }) => trial.phase === 'test');
  expect(tests).toHaveLength(12); expect(new Set(tests.map((trial: { id: string }) => trial.id)).size).toBe(12);
  for (const previous of sealed) expect(tests.some((trial: { id: string }) => trial.id === previous.id)).toBe(true);
  for (const arm of report.heldOut) {
    expect(arm.trialIds).toHaveLength(6); expect(arm.trialScores).toHaveLength(6); expect(arm.standardError).toBe(0);
    for (const recordId of ['sealed-a', 'sealed-b']) {
      expect(tests.filter((trial: { candidateId: string; recordId: string }) => trial.candidateId === arm.candidateId && trial.recordId === recordId)).toHaveLength(3);
    }
  }
  const markdown = await readFile(join(f.root, 'out/REPORT.md'), 'utf8');
  expect(markdown).toContain('Trial standard error');
  const view = await (await loadInvocationViewer(join(f.root, 'out')))();
  expect(view.heldOut?.map(arm => arm.trialScores?.length)).toEqual([6, 6]);
  expect(await main([...argv, '--resume'], f.io, f.dependencies)).toBe(0);
  expect(f.observedInstructions).toHaveLength(16);
}, 60000);
