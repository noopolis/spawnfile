import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { snapshotCandidate } from '../../candidates/index.js';
import { openExperimentStore } from '../../storage/index.js';
import type { InferenceProvider } from '../../contracts/execution.js';
import { runStoredTrial } from './stored.js';
import { setup } from './fixture.js';

const invalid = JSON.stringify({ score: 0.5, verdict: 'fail', reasons: ['Improve prose'],
  citations: [{ source: 'input', quote: 'PRIVATE-RAW-INVALID-CITATION' }] });
const repaired = JSON.stringify({ citations: [{ source: 'input', quote: 'DONE' }] });
async function fixture() {
  const task = await setup();
  const source = join(task.options.root, 'source'); await mkdir(source); await writeFile(join(source, 'AGENTS.md'), 'Write DONE.');
  const candidate = await snapshotCandidate({ sourceRoot: source, resources: [{ id: 'instructions', sourcePath: 'AGENTS.md',
    destinations: [{ kind: 'instructions', path: 'AGENTS.md' }], edit: 'whole-file' }] });
  const storeRoot = join(task.options.root, 'store'), store = await openExperimentStore(storeRoot);
  const replies = [invalid, repaired];
  const generate = vi.fn<InferenceProvider['generate']>(async () => ({ text: replies.shift()!, model: 'actual', route: 'test',
    usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, reasoningTokens: null, source: 'test' } }));
  task.options.evaluation.judges = { editor: { model: 'requested', citationRepairs: 1, provider: { id: 'test',
    capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false }, generate } } };
  task.options.record.effectiveStages = [{ id: 'quality', checks: [{ id: 'prose', eval: 'llm-rubric', input: 'output.text', judge: 'editor',
    rubric: { prompt: 'Fixed rubric' }, minimum: 0.8 }] }];
  return { task, store, generate, options: { ...task.options, candidate, store, storeRoot, datasetId: 'suite' } };
}

it('stores complete raw attempts privately and only call metadata in the replayable trial report', async () => {
  const { store, generate, options } = await fixture();
  const observer = vi.fn(); options.evaluation.observeJudgeAttempt = observer;
  const report = await runStoredTrial(options);
  expect(report).toMatchObject({ status: 'fail', execution: 'completed', evaluation: { status: 'fail' } });
  expect(generate).toHaveBeenCalledTimes(2); expect(observer).toHaveBeenCalledTimes(2);
  expect(report.snapshot.events).toEqual([]);
  expect(report.evaluation.judgeCalls).toHaveLength(2);
  expect(JSON.stringify(report)).not.toContain('PRIVATE-RAW-INVALID-CITATION');
  const replay = await store.readReplay('trial', { audience: 'operator', phase: 'replay' });
  const attempts = replay.events.filter(event => (event.payload as { type: string }).type === 'judge.attempt');
  expect(attempts).toHaveLength(2);
  expect(attempts[0]!.payload).toMatchObject({ payload: { response: invalid,
    violation: { code: 'invalid-citations', citations: [{ index: 0, source: 'input' }] } } });
  for (const audience of ['optimizer', 'viewer'] as const) {
    const restricted = await store.readReplay('trial', { audience, phase: 'training' });
    expect(JSON.stringify(restricted)).not.toContain('PRIVATE-RAW-INVALID-CITATION');
    expect(JSON.stringify(restricted)).not.toContain('judge.attempt');
  }
});

it('cannot silently repair or complete after a protected audit sink fails', async () => {
  const { store, generate, options } = await fixture();
  const append = store.appendEvent.bind(store);
  store.appendEvent = async (...args) => {
    if ((args[1].payload as { type: string }).type === 'judge.attempt') throw new Error('Disk unavailable');
    return append(...args);
  };
  await expect(runStoredTrial(options)).rejects.toThrow('evidence persistence failed');
  expect(generate).toHaveBeenCalledTimes(1);
  expect((await store.readReplay('trial', { audience: 'operator', phase: 'replay' })).evaluations).toEqual([]);
});
