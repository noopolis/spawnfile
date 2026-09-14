import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDatasetYaml, resolveDataset } from '../../cases/index.js';
import { createEvaluationRegistry } from '../../evaluation/index.js';
import { runTrial } from '../trials/index.js';
import type { InferenceProvider } from '../../contracts/execution.js';
import { trialScore } from './scoring.js';
import { trainingFeedback } from './feedback.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const text = 'The factory added 20 jobs.';
const dataset = (qualityWeight: number, efficiencyWeight: number) => resolveDataset(parseDatasetYaml(`
schema: paideia.dataset.v1
id: dual-pressure
stages:
  - id: objective
    checks:
      - id: quality
        eval: llm-rubric
        input: output.text
        judge: editor
        rubric: {prompt: Assess the stated writing criterion.}
        minimum: 0.8
      - id: efficiency
        eval: token-efficiency
        metric: total
        target_tokens: 1000
    gate: {passed: quality}
    score:
      linear: {quality: ${qualityWeight}, efficiency: ${efficiencyWeight}}
records:
  - id: task
    input: {prompt: Write the assigned report.}
`), { registry: { judges: { editor: { version: 'deterministic-test' } } } }).records[0]!;

async function measure(options: { quality: number; tokens: number; qualityWeight?: number; efficiencyWeight?: number;
  judgeTokens?: number; complete?: boolean; failed?: boolean }) {
  const root = await mkdtemp(join(tmpdir(), 'paideia-dual-pressure-')); roots.push(root);
  const record = dataset(options.qualityWeight ?? 80, options.efficiencyWeight ?? 20);
  const provider: InferenceProvider = { id: 'deterministic-judge',
    capabilities: { tools: 'disabled', billing: 'local', temperature: false, seed: false },
    async generate() { return { text: JSON.stringify({ score: options.quality,
      verdict: options.quality >= 0.8 ? 'pass' : 'fail', reasons: ['Deterministic criterion fixture'],
      citations: [{ source: 'input', quote: text }] }), model: 'test-judge', route: 'test',
      usage: { inputTokens: options.judgeTokens ?? 100, outputTokens: 20, cachedInputTokens: 0, reasoningTokens: null, source: 'judge' } }; },
  };
  const report = await runTrial({ root, id: 'trial', phase: 'train', record, candidateId: 'candidate',
    datasetDigest: 'dataset', planDigest: 'plan', model: 'deterministic-subject', timeoutMs: 2000,
    prepare: async () => ({ instructions: 'Write the report.' }), persist: async () => {},
    registry: createEvaluationRegistry(), evaluation: { judges: { editor: { provider, model: 'test-judge' } }, embeddings: {}, readText: async () => '' },
    adapter: { id: 'deterministic-subject', capabilities: { toolTrace: 'none', liveObservations: false,
      cancellation: 'native-handle', multiTurn: false, resources: ['instructions'], isolation: 'test facade',
      readIsolation: 'declared-paths', protectedPaths: true },
      async start() { return {
        async run() { return { status: options.failed ? 'failed' : 'completed', text,
          usage: { inputTokens: options.tokens - 10, outputTokens: 10, cachedInputTokens: options.tokens - 10,
            reasoningTokens: 5, source: 'subject' },
          coverage: [{ channel: 'output', completeness: 'complete', ordering: 'source' },
            { channel: 'usage', completeness: options.complete === false ? 'partial' : 'complete', ordering: 'source' }] }; },
        async stop(reason) { return { state: 'acknowledged', scope: 'native-handle', quiescence: 'confirmed',
          remoteWork: 'unknown', reason, detail: 'Deterministic subject stopped' }; },
      }; },
    },
  });
  return { record, report };
}

it('drives the actual optimizer reward with both quality and subject tokens', async () => {
  const baseline = await measure({ quality: 0.9, tokens: 1000 });
  const better = await measure({ quality: 0.95, tokens: 1000 });
  const cheaper = await measure({ quality: 0.9, tokens: 500 });
  expect(trialScore(baseline.report)).toBeCloseTo(0.8 * 0.9 + 0.2 * 0.5);
  expect(trialScore(better.report)).toBeGreaterThan(trialScore(baseline.report));
  expect(trialScore(cheaper.report)).toBeGreaterThan(trialScore(baseline.report));
  expect(cheaper.report.evaluation.checks.efficiency!.score).toBeCloseTo(2 / 3);
  expect(cheaper.report.snapshot.subjectUsage?.usage?.inputTokens).toBe(490);
  const feedback = JSON.parse(trainingFeedback(cheaper.record, cheaper.report).feedback);
  expect(feedback.criteria[0].score.linear).toEqual({ quality: 80, efficiency: 20 });
  expect(feedback.evaluation.checks.efficiency.score).toBeCloseTo(2 / 3);
});

it('authored relative weights change the preferred tradeoff without relaxing quality floors', async () => {
  const qualityFirst = await measure({ quality: 1, tokens: 3000 });
  const efficient = await measure({ quality: 0.81, tokens: 100 });
  expect(trialScore(qualityFirst.report)).toBeGreaterThan(trialScore(efficient.report));
  const qualityBalanced = await measure({ quality: 1, tokens: 3000, qualityWeight: 50, efficiencyWeight: 50 });
  const efficientBalanced = await measure({ quality: 0.81, tokens: 100, qualityWeight: 50, efficiencyWeight: 50 });
  expect(trialScore(efficientBalanced.report)).toBeGreaterThan(trialScore(qualityBalanced.report));
  const bad = await measure({ quality: 0.79, tokens: 10, qualityWeight: 1, efficiencyWeight: 99 });
  expect(bad.report.status).toBe('fail');
  expect(trialScore(bad.report)).toBe(0);
});

it('excludes judging overhead and refuses missing or failed subject work as a cheap candidate', async () => {
  const ordinary = await measure({ quality: 0.9, tokens: 1000 });
  const expensiveJudge = await measure({ quality: 0.9, tokens: 1000, judgeTokens: 9_000_000 });
  expect(trialScore(expensiveJudge.report)).toBe(trialScore(ordinary.report));
  const partial = await measure({ quality: 0.9, tokens: 100, complete: false });
  expect(partial.report.evaluation.checks.efficiency!.status).toBe('unknown');
  expect(() => trialScore(partial.report)).toThrow(/coverage|unscorable/);
  const failed = await measure({ quality: 0.9, tokens: 100, failed: true });
  expect(failed.report.evaluation.checks.efficiency!.score).toBeUndefined();
  expect(() => trialScore(failed.report)).toThrow(/infrastructure/);
});
