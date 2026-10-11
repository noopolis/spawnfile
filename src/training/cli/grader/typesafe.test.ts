import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { main } from '../commands.js';
import { parseGrader, allQuestions, stableDigest } from '../../graders/index.js';
import { runCalibrate } from './calibrate.js';
import { createTypeSafeDecision } from '../../inference/decision/index.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(count: number) {
  const root = await mkdtemp(join(tmpdir(), 'typesafe-calibration-')); roots.push(root);
  const graderFile = join(root, 'grader.yaml');
  const grader = parseGrader({ schema: 'paideia.grader.v1', id: 'quality', golden: 'labels.yaml', calibration: 'calibration.json',
    teachers: [{ id: 'teacher', provider: 'claude', model: 'opus' }],
    model: { backend: 'typesafe', name: 'jev-1.13.0' },
    escalate: { to: 'teacher', between: [0.4, 0.6] },
    questions: [{ id: 'q', type: 'yes-no', expected: 'yes', reads: ['output.good'], ask: 'Is it good?' },
      { id: 'q2', type: 'yes-no', expected: 'yes', reads: ['output.good'], ask: 'Is it accurate?' }], score: { method: 'weighted' } });
  const labels = { schema: 'paideia.labels.v1', grader: 'quality', labelers: { human: { kind: 'human', name: 'Reader' } },
    labels: Array.from({ length: count }, (_, i) => ({ id: `o${i}`, lineage: `g${i}`, output: { good: i % 2 === 0 }, context: {},
      votes: { q: { human: i % 2 === 0 ? 'yes' : 'no' }, q2: { human: i % 2 === 0 ? 'yes' : 'no' } },
      provenance: { human: { votes: Object.fromEntries(allQuestions(grader).map(question => [question.id, {
        question_digest: stableDigest(question), projection_digest: stableDigest({ 'output.good': i % 2 === 0 }),
      }])) } } })) };
  await writeFile(graderFile, stringify(grader)); await writeFile(join(root, 'labels.yaml'), stringify(labels));
  return { root, graderFile, grader };
}

it('batches TypeSafe calibration, reports paid totals, excludes cache hits and never persists the key', async () => {
  const f = await fixture(4), secret = 'FAKE_KEY_NEVER_PERSIST_CALIBRATION';
  vi.stubEnv('TYPESAFE_API_KEY', secret);
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const body = JSON.parse(String(init!.body)) as { questions: Record<string, unknown> };
    return Response.json({ model: 'jev-1.13.0', usage: { input_tokens: 100, output_tokens: 0 },
      echoedAuthorization: secret, answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { type: 'noul', noul: 0.9 }])) });
  });
  vi.stubGlobal('fetch', fetch);
  const first = await runCalibrate(f);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(first.decisionAccounting).toMatchObject({ billing: 'api', requests: 2, inputTokens: 200, outputTokens: 0 });
  expect(first.decisionAccounting!.usd).toBeCloseTo(0.0000084, 12);
  expect(first.decisionAccounting!.latencyMs.p95).toBeGreaterThanOrEqual(first.decisionAccounting!.latencyMs.p50!);
  const report = await readFile(first.reportFile, 'utf8');
  expect(report).toContain('decisionAccounting');
  const { readdir } = await import('node:fs/promises');
  const cacheDirectory = join(f.root, '.paideia/grader-cache');
  const cache = await Promise.all((await readdir(cacheDirectory)).map(file => readFile(join(cacheDirectory, file), 'utf8')));
  expect(JSON.stringify(first) + report + cache.join('')).not.toContain(secret);
  const second = await runCalibrate(f);
  expect(second.decisionAccounting).toMatchObject({ requests: 0, inputTokens: 0, usd: 0 });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('shares the authored TypeSafe spend cap across candidates and permits an explicit CLI override', async () => {
  const f = await fixture(2);
  const { model, ...rest } = f.grader;
  await writeFile(f.graderFile, stringify({ ...rest, max_spend_usd: 0,
    models: [{ ...model, id: 'one', concurrency: 1 }, { ...model, id: 'two', concurrency: 1 }] }));
  vi.stubEnv('TYPESAFE_API_KEY', 'FAKE_SPEND_KEY');
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const body = JSON.parse(String(init!.body)) as { questions: Record<string, unknown> };
    return Response.json({ model: 'jev-1.13.0', usage: { input_tokens: 1_000_000, output_tokens: 0 },
      answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { type: 'noul', noul: 0.9 }])) });
  });
  vi.stubGlobal('fetch', fetch);
  const stopped = await runCalibrate(f);
  expect(fetch).not.toHaveBeenCalled();
  expect(await readFile(stopped.reportFile, 'utf8')).toContain('spend cap');
  expect(stopped.code).toBe(1);
  const output: string[] = [];
  expect(await main(['grader', 'calibrate', '--grader', f.graderFile, '--max-spend-usd', '0.0001'],
    { cwd: f.root, stdout: text => output.push(text), stderr: text => { throw new Error(text); } })).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(output[0]!).decisionAccounting).toMatchObject({ requests: 1, inputTokens: 1_000_000, usd: 0.042 });
  expect(await readFile(stopped.reportFile, 'utf8')).toContain('spend cap');
});

it('counts shared backend receipts once and only within the current calibration invocation', async () => {
  const f = await fixture(2);
  const { model, ...rest } = f.grader;
  await writeFile(f.graderFile, stringify({ ...rest,
    models: [{ ...model, id: 'one' }, { ...model, id: 'two' }] }));
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const body = JSON.parse(String(init!.body)) as { questions: Record<string, unknown> };
    return Response.json({ model: 'jev-1.13.0', usage: { input_tokens: 100, output_tokens: 0 },
      answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { type: 'noul', noul: 0.9 }])) });
  });
  const backend = createTypeSafeDecision({ model: 'jev-1.13.0', env: { TYPESAFE_API_KEY: 'fake-shared-key' }, fetch });
  const dependencies = { backend: () => backend };
  const first = await runCalibrate(f, dependencies);
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(first.decisionAccounting).toMatchObject({ requests: 4, inputTokens: 400, outputTokens: 0 });
  expect(first.decisionAccounting!.receipts).toHaveLength(4);
  expect(first.decisionAccounting!.usd).toBeCloseTo(0.0000168, 12);
  const second = await runCalibrate(f, dependencies);
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(backend.requestReceipts!()).toHaveLength(4);
  expect(second.decisionAccounting).toMatchObject({ requests: 0, inputTokens: 0, outputTokens: 0, usd: 0, receipts: [] });
  const report = await readFile(second.reportFile, 'utf8');
  expect(report).toContain('"requests": 0');
  expect(report).toContain('"usd": 0');
});

it.each([1, 2])('emits completed and failed API receipts after %i successful calibration requests', async completed => {
  const f = await fixture(2), secret = 'FAKE_SECRET_FAILURE_ACCOUNTING';
  const { model, ...rest } = f.grader;
  await writeFile(f.graderFile, stringify({ ...rest,
    models: [{ ...model, id: 'one', concurrency: 1 }, { ...model, id: 'two', concurrency: 1 }] }));
  vi.stubEnv('TYPESAFE_API_KEY', secret);
  let calls = 0;
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    calls++;
    if (calls > completed) return new Response(secret, { status: 529 });
    const body = JSON.parse(String(init!.body)) as { questions: Record<string, unknown> };
    return Response.json({ model: 'jev-1.13.0', usage: { input_tokens: 100, output_tokens: 0 },
      echoedAuthorization: secret, answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { type: 'noul', noul: 0.9 }])) });
  }));
  const stdout: string[] = [], stderr: string[] = [];
  expect(await main(['grader', 'calibrate', '--grader', f.graderFile], {
    cwd: f.root, stdout: text => stdout.push(text), stderr: text => stderr.push(text),
  })).toBe(2);
  const result = JSON.parse(stdout[0]!) as { decisionAccounting: { receipts: { status: number; inputTokens: number | null }[] } };
  expect(result).toMatchObject({ schema: 'paideia.grader-failure.v1', command: 'calibrate', status: 'failed' });
  expect(result.decisionAccounting.receipts.filter(receipt => receipt.status === 200)).toHaveLength(completed);
  expect(result.decisionAccounting.receipts.filter(receipt => receipt.status === 529).length).toBeGreaterThanOrEqual(3);
  expect(result.decisionAccounting.receipts.slice(0, completed).map(receipt => receipt.inputTokens)).toEqual(Array(completed).fill(100));
  expect(JSON.stringify(result) + stderr.join('')).not.toContain(secret);
  expect(stderr.join('')).toContain('retry attempts exhausted');
});
