import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createDaimonNativeAdapter } from '../index.js';
import { childFixture } from './fixture.js';
import { parseDatasetYaml, resolveDataset } from '../../../cases/index.js';
import { createEvaluationRegistry } from '../../../evaluation/index.js';
import { runTrial, trialScore, type TrialOptions, type TrialReport } from '../../../experiments/index.js';
import type { SubjectAdapter, SubjectSession, SubjectTurnResult } from '../../../contracts/execution.js';

vi.mock('./sandbox.js', () => ({ verifyChildSandbox: vi.fn(async () => undefined) }));
const roots: string[] = [];
afterEach(async () => { vi.clearAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/** One required artifact the filing would produce, so the verdict is exactly the subject's. */
const filing = () => resolveDataset(parseDatasetYaml(`schema: paideia.dataset.v1
id: newsroom
stages:
  - id: accepted-article
    checks:
      - {id: filed, eval: tool-called, tool: mcp_newsroom_file_article}
      - {id: body, eval: contains-any, input: 'artifact:accepted-article#/body', values: [Filed]}
    score:
      linear: {filed: 0.5, body: 0.5}
    gate: {all: [{passed: filed}, {passed: body}]}
records:
  - id: record
    group: unique
    input: {prompt: file the assigned story}
    outputs: {accepted-article: article.json}
`)).records[0]!;

/**
 * The real child, the real loopback protocol and the real closure query: the only
 * thing borrowed is the trial's own stimulus, because the worker owns the fresh
 * workspace the launch receipt pins. Every continuation the budget admits defers,
 * so the last one exhausts it — and by then the worker has stopped its own host.
 */
async function nativeDeferredTrial(mode: string, maxDeliveries = 1): Promise<{ report: TrialReport; turn: SubjectTurnResult; deliveries: number }> {
  const fixture = await childFixture(mode); roots.push(fixture.root);
  const text = 'Sourced research reply';
  const next = vi.fn(async () => ({ id: `answer-${next.mock.calls.length}`, text,
    source: { kind: 'transport', id: `answer-${next.mock.calls.length}`, sha256: `sha256:${createHash('sha256').update(text).digest('hex')}` } }));
  const native = createDaimonNativeAdapter({ timeoutMs: 20_000, execution: { kind: 'child-process', externalInputs: { maxDeliveries, next } } });
  const session = await native.start(fixture.input);
  let turn: SubjectTurnResult | undefined;
  const adapter: SubjectAdapter = { id: 'daimon-native-child', capabilities: native.capabilities,
    async start(): Promise<SubjectSession> {
      return { run: async (value, signal) => { turn = await session.run({ id: value.id, text: value.text }, signal); return turn; },
        stop: reason => session.stop(reason) };
    } };
  const options: TrialOptions = { id: fixture.input.trialId, phase: 'train', record: filing(), candidateId: 'candidate',
    datasetDigest: 'dataset', planDigest: 'plan', adapter, model: fixture.input.model!, root: fixture.root, timeoutMs: 20_000,
    prepare: async () => ({ instructions: fixture.input.instructions }), registry: createEvaluationRegistry(),
    evaluation: { judges: {}, embeddings: {}, readText: async () => { throw new Error('unregistered sidecar'); } },
    persist: async () => undefined };
  const report = await runTrial(options);
  return { report, turn: turn!, deliveries: next.mock.calls.length };
}

/**
 * The gap this closes. A subject that ran every wake its budget allowed, spent the
 * money, deferred each delivery and never filed the article is a behavioural zero —
 * but proving it needs the closure receipt, and the receipt needs the v2 activity
 * projection from a host the worker has *already* stopped. Daimon answered 503
 * `native_host_unavailable` there, so the trial demoted to an unscorable
 * infrastructure failure. The receipt below is obtained, never assumed.
 */
it('scores a zero for a subject that exhausted its continuation budget still deferred', async () => {
  const { report, turn, deliveries } = await nativeDeferredTrial('blocked-always');
  // The turn really deferred and the continuation budget really ran out.
  expect(turn).toMatchObject({ status: 'failed', blocked: 'awaiting-external-input' });
  expect(turn.error).toBe('Native execution completed; delivery blocked awaiting external input');
  expect(deliveries).toBe(1);
  // Obtained from the stopped host's sealed projection, not stipulated by a stub.
  expect(turn.stop).toMatchObject({ state: 'acknowledged', quiescence: 'confirmed' });
  expect(report.stop).toMatchObject({ state: 'acknowledged', quiescence: 'confirmed' });
  expect(report.execution).toBe('deferred');
  expect(report.hostWork).toBe('settled');
  // Deferred is never success: the unanswered delivery is the failing witness, and
  // the measured checks keep their own honest verdicts rather than becoming zeros.
  expect(report.status).toBe('fail');
  expect(report.evaluation.stages[0]!.checks.map(check => check.status)).toEqual(['unknown', 'unknown']);
  expect(report.evaluation.stages[0]!.gate.status).not.toBe('pass');
  expect(trialScore(report)).toBe(0);
  // Both wakes were metered and neither became completed training evidence.
  expect(turn.usage?.inputTokens).toBe(200);
  expect(report.snapshot.output).toBe('');
});

/**
 * The guard that keeps this from becoming "score everything". Each of these really
 * ran and none of them can prove its execution closed, so each stays an
 * infrastructure failure and refuses to produce a number.
 *
 * `blocked-always-unanswerable` is the observed pre-fix host: the delivery deferred
 * and the budget ran out exactly as above, and the only difference is that the
 * closure query is not answered. `die-mid-turn` crashes the worker and `stall`
 * never replies until the caller cancels it.
 */
it.each([
  ['blocked-always-unanswerable', 'failed'],
  ['die-mid-turn', 'failed'],
])('refuses to score an execution whose closure is unproven: %s', async (mode, execution) => {
  const { report, turn } = await nativeDeferredTrial(mode);
  expect(report.execution).toBe(execution);
  expect(turn.stop?.quiescence ?? 'unknown').toBe('unknown');
  expect(report.stop).toMatchObject({ quiescence: 'unknown' });
  expect(report.status).toBe('error');
  expect(() => trialScore(report)).toThrow('failed in infrastructure');
});

it('refuses to score a cancelled execution even when the subject had really deferred', async () => {
  const fixture = await childFixture('stall'); roots.push(fixture.root);
  const native = createDaimonNativeAdapter({ timeoutMs: 1_000, execution: { kind: 'child-process' } });
  const session = await native.start(fixture.input);
  const adapter: SubjectAdapter = { id: 'daimon-native-child', capabilities: native.capabilities,
    async start(): Promise<SubjectSession> {
      return { run: (value, signal) => session.run({ id: value.id, text: value.text }, signal), stop: reason => session.stop(reason) };
    } };
  const report = await runTrial({ id: fixture.input.trialId, phase: 'train', record: filing(), candidateId: 'candidate',
    datasetDigest: 'dataset', planDigest: 'plan', adapter, model: fixture.input.model!, root: fixture.root, timeoutMs: 700,
    prepare: async () => ({ instructions: fixture.input.instructions }), registry: createEvaluationRegistry(),
    evaluation: { judges: {}, embeddings: {}, readText: async () => { throw new Error('unregistered sidecar'); } },
    persist: async () => undefined });
  // The deadline cancelled a worker that never answered: containment is unknown and
  // the trial is the machine's outcome, never a measured behavioural zero.
  expect(report.execution).toBe('interrupted');
  expect(report.stop).toMatchObject({ quiescence: 'unknown' });
  expect(() => trialScore(report)).toThrow(/incomplete/u);
});
