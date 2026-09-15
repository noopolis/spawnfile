import { readFile } from 'node:fs/promises';
import { expect, test, vi } from 'vitest';
import { parseDatasetYaml, resolveDataset } from '../../cases/index.js';
import type { InferenceProvider } from '../../contracts/execution.js';
import { rescoreStoredTrial } from './index.js';
import { fixture } from './fixture.js';
import { trialReportSchema } from './schema.js';

async function auditFixture() {
  const f = await fixture();
  const invalid = JSON.stringify({ score: 0.52, verdict: 'fail', reasons: ['Improve prose'],
    citations: [{ source: 'input', quote: 'PRIVATE-REPLAY-QUOTE' }] });
  const replies = [invalid, JSON.stringify({ citations: [{ source: 'input', quote: 'ARTICLE' }] })];
  const generate = vi.fn<InferenceProvider['generate']>(async () => ({ text: replies.shift()!, model: 'actual', route: 'test',
    usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, reasoningTokens: null, source: 'test' } }));
  f.options.evaluation.judges = { editor: { model: 'requested', citationRepairs: 1, provider: { id: 'test',
    capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false }, generate } } };
  f.options.dataset = resolveDataset(parseDatasetYaml(`schema: paideia.dataset.v1
id: audited
checks: [{id: prose, eval: llm-rubric, input: output.text, judge: editor, rubric: {prompt: Fixed rubric}, minimum: 0.8}]
records: [{id: story, input: {prompt: Never execute}}]
`), { registry: { judges: { editor: { version: '1' } } } });
  return { ...f, generate, invalid };
}

test('rescore persists raw attempts privately, preserves call lineage and never rewrites the original capture', async () => {
  const { options, store, originalPath, generate, invalid, report } = await auditFixture();
  const before = await readFile(originalPath);
  const observer = vi.fn(); options.evaluation.observeJudgeAttempt = observer;
  const rescored = await rescoreStoredTrial(options);
  expect(rescored).toMatchObject({ status: 'fail', evaluation: { status: 'fail' } });
  expect(rescored.evaluation.checks.prose!.score).toBe(0.52);
  expect(generate).toHaveBeenCalledTimes(2); expect(observer).toHaveBeenCalledTimes(2);
  expect(await readFile(originalPath)).toEqual(before);
  expect(JSON.stringify(rescored)).not.toContain('PRIVATE-REPLAY-QUOTE');
  const replay = await store.readReplay('trial', options.access);
  expect(replay.events.filter(event => (event.payload as { type: string }).type === 'judge.attempt')).toHaveLength(2);
  expect(JSON.stringify(replay.events)).toContain(JSON.stringify(invalid).slice(1, -1));
  // Reading a source trial must retain policy/linkage, not strip additive metadata.
  report.evaluation = rescored.evaluation;
  expect(trialReportSchema.parse(report).evaluation.judgeCalls).toEqual(rescored.evaluation.judgeCalls);
  for (const citationRepairs of [2, -1]) {
    const invalidReport = structuredClone(report);
    invalidReport.evaluation.judgeCalls![0]!.citationRepairs = citationRepairs as 1;
    expect(() => trialReportSchema.parse(invalidReport)).toThrow();
  }
  for (const audience of ['optimizer', 'viewer'] as const) {
    expect(JSON.stringify(await store.readReplay('trial', { audience, phase: 'training' }))).not.toContain('PRIVATE-REPLAY-QUOTE');
  }
});

test.each(['sink', 'observer'] as const)('does not retry or claim a successful rescore when the %s fails', async target => {
  const { options, store, generate } = await auditFixture();
  if (target === 'sink') store.appendEvent = async () => { throw new Error('Disk unavailable'); };
  else options.evaluation.observeJudgeAttempt = () => { throw new Error('Private callback unavailable'); };
  const rescored = await rescoreStoredTrial(options);
  expect(rescored).toMatchObject({ status: 'error', evaluation: { status: 'error' } });
  expect(rescored.evaluation.checks.prose!.reason).toBe('Judge attempt evidence persistence failed');
  expect(rescored.evaluation.judgeCalls![0]!.usage!.inputTokens).toBe(10);
  expect(generate).toHaveBeenCalledTimes(1);
});

test.each([false, true])('preserves schema-failure evidence only in protected audit (routed=%s)', async routed => {
  const { InferenceFailure, createRoutedInference } = await import('../../inference/index.js');
  const { captureInferenceDiagnostic } = await import('../../inference/index.js');
  const { options, store } = await auditFixture();
  const rejected = 'PRIVATE-ATTESTED-SCHEMA-REJECTION';
  const primary = { ...options.evaluation.judges.editor!.provider, id: 'primary', generate: async () => {
    throw new InferenceFailure('invalid-response', 'Schema rejected', { diagnostic: captureInferenceDiagnostic('response-schema', rejected),
      usage: { inputTokens: 15847, outputTokens: 695, cachedInputTokens: 0, reasoningTokens: null, source: 'fixture' } });
  } };
  const fallback = { ...primary, id: 'fallback', generate: async () => ({ model: 'actual', route: 'fallback', usage: null,
    text: JSON.stringify({ score: 0.9, verdict: 'pass', reasons: ['Good'], citations: [{ source: 'input', quote: 'ARTICLE' }] }) }) };
  const provider = routed ? createRoutedInference({ id: 'route', routes: [{ provider: primary, model: 'first' }, { provider: fallback, model: 'second' }],
    maxAttempts: 2, timeoutMs: 1000 }) : primary;
  options.evaluation.judges = { editor: { model: 'requested', provider } };
  const result = await rescoreStoredTrial(options);
  expect(result.status).toBe(routed ? 'pass' : 'error');
  expect(JSON.stringify(result)).not.toContain(rejected);
  const replay = await store.readReplay('trial', options.access);
  const attempts = replay.events.filter(event => (event.payload as { type: string }).type === 'judge.attempt');
  expect(attempts).toHaveLength(routed ? 2 : 1);
  const first = attempts[0]!.payload as { payload: { call: { id: string; failureKind: string }; response: string; diagnostic: unknown } };
  expect(first.payload.call.failureKind).toBe('invalid-response');
  expect(first.payload.call.id).toBe(result.evaluation.judgeCalls![0]!.id);
  expect(first.payload.response).toBe(rejected);
  expect(first.payload.diagnostic).toMatchObject({ code: 'response-schema', response: { text: rejected } });
  for (const audience of ['optimizer', 'viewer'] as const) {
    expect(JSON.stringify(await store.readReplay('trial', { audience, phase: 'training' }))).not.toContain(rejected);
  }
});
