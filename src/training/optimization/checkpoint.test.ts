import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDspyOptimization } from './runner.js';
import { simulatedOptions } from './testSupport.js';
import { OptimizationCheckpoint } from './checkpoint.js';
import { DSPY_SCHEMA, startSchema, type DspyRequest } from './protocol.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function directory() { const root = await mkdtemp(join(tmpdir(), 'paideia-resume-')); roots.push(root); return root; }

it('restores actual GEPA state after interruption without repeating settled subject or generation callbacks', async () => {
  const { options, evaluations, generations } = simulatedOptions();
  const root = await directory();
  options.checkpoint = { directory: root, identity: 'frozen-environment', resume: false };
  const evaluate = options.evaluate;
  let fail = true;
  options.evaluate = async (request, signal, callbackId) => {
    if (callbackId === 'call-4' && fail) { fail = false; throw new Error('controlled interruption'); }
    return evaluate(request, signal);
  };
  await expect(runDspyOptimization(options)).rejects.toThrow('controlled interruption');
  const paired = JSON.parse(await readFile(join(root, 'optimizer.json'), 'utf8'));
  expect(paired.payload.gepa.length).toBeGreaterThan(100);
  expect(paired.payload.session.evaluations).toBe(1);
  expect(evaluations).toHaveLength(2);
  expect(generations).toHaveLength(1);
  options.checkpoint.resume = true;
  const result = await runDspyOptimization(options);
  expect(result.provenance).toMatchObject({ evaluations: 7, proposals: 2, selectedCandidateIndex: 2 });
  expect(evaluations).toHaveLength(7);
  expect(generations).toHaveLength(2);
  expect(new Set(result.provenance.captures.map(capture => capture.captureId)).size).toBe(7);
  const journal = JSON.parse(await readFile(join(root, 'host.json'), 'utf8'));
  expect(journal.entries.find((entry: { request: { id: string } }) => entry.request.id === 'call-4').attempts).toBe(2);
  await expect(runDspyOptimization({ ...options, checkpoint: { ...options.checkpoint, identity: 'changed-environment' } })).rejects.toThrow('identity');
});

it('rejects drift, corruption, overwriting history and exhausted cumulative pending attempts', async () => {
  const root = await directory();
  const start = startSchema.parse({ schema: DSPY_SCHEMA, kind: 'optimize', id: 'run', components: { prompt: 'one' },
    trainCaseIds: ['train'], validationCaseIds: ['validation'], budget: { maxMetricCalls: 1, maxProposals: 1 } });
  const config = { directory: root, identity: 'environment', resume: false };
  const checkpoint = await OptimizationCheckpoint.open(start, config);
  const request: DspyRequest = { schema: DSPY_SCHEMA, kind: 'request', id: 'call-1', method: 'evaluate',
    params: { caseId: 'validation', split: 'validation', components: { prompt: 'one' } } };
  await checkpoint.begin(request, start.budget);
  await expect(checkpoint.begin(request, start.budget)).rejects.toThrow('Cumulative');
  await expect(checkpoint.begin({ ...request, params: { ...request.params, components: { prompt: 'changed' } } }, start.budget)).rejects.toThrow('diverged');
  await expect(OptimizationCheckpoint.open(start, config)).rejects.toThrow('EEXIST');
  await writeFile(join(root, 'host.json'), JSON.stringify({ identity: 'tampered', entries: [], digest: 'tampered' }));
  await expect(OptimizationCheckpoint.open(start, { ...config, resume: true })).rejects.toThrow('integrity');
});

it('keeps immutable validated results, canonical callback identity, and protected journal snapshots', async () => {
  const root = await directory();
  const start = startSchema.parse({ schema: DSPY_SCHEMA, kind: 'optimize', id: 'run', components: { prompt: 'one' },
    trainCaseIds: ['train'], validationCaseIds: ['validation'], budget: { maxMetricCalls: 2, maxProposals: 1 } });
  const config = { directory: root, identity: 'environment', resume: false };
  const checkpoint = await OptimizationCheckpoint.open(start, config);
  const request: DspyRequest = { schema: DSPY_SCHEMA, kind: 'request', id: 'call-1', method: 'evaluate',
    params: { caseId: 'validation', split: 'validation', components: { prompt: 'one' } } };
  const entry = await checkpoint.begin(request, start.budget);
  await expect(checkpoint.complete(entry, { invalid: true })).rejects.toThrow();
  const result = { score: 1, feedback: '', output: '', captureId: 'capture' };
  await checkpoint.complete(entry, result);
  await expect(checkpoint.complete(entry, { ...result, score: 0 })).rejects.toThrow('pending');
  checkpoint.entries[0]!.result = 'outside mutation';
  const reordered = { ...request, params: { components: { prompt: 'one' }, split: 'validation' as const, caseId: 'validation' } };
  expect((await checkpoint.begin(reordered, start.budget)).result).toEqual(result);
  const generation: DspyRequest = { schema: DSPY_SCHEMA, kind: 'request', id: 'call-2', method: 'generate',
    params: { purpose: 'reflection', messages: [{ role: 'user', content: 'reflect' }], options: {} } };
  const pending = await checkpoint.begin(generation, start.budget);
  const inference = { text: 'proposal', model: 'model', route: 'local', usage: null };
  await expect(checkpoint.complete(pending, { text: 'different', model: 'model', usage: null }, inference)).rejects.toThrow('differs');
  await checkpoint.complete(pending, { text: 'proposal', model: 'model', usage: null }, inference);
  const restored = await OptimizationCheckpoint.open(start, { ...config, resume: true });
  expect(restored.entries).toHaveLength(2);
});

it('restores classified failed inference usage and stops GEPA cleanly at the cumulative proposal budget', async () => {
  const { InferenceFailure } = await import('../inference/index.js');
  const { options, generations } = simulatedOptions();
  options.checkpoint = { directory: await directory(), identity: 'known-usage', resume: false };
  const generate = options.generate;
  let failing = true;
  const attempt = { id: 'actual-provider-attempt', ordinal: 1, providerId: 'local', requestedModel: 'model',
    responseModel: null, responseRoute: null, outcome: 'failed' as const, failureKind: 'transport' as const,
    startedAt: 'start', completedAt: 'end', usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2,
      reasoningTokens: null, source: 'provider' } };
  options.generate = async (request, signal) => {
    if (failing) { failing = false; throw new InferenceFailure('transport', 'interrupted generation', { attempts: [attempt] }); }
    return generate(request, signal);
  };
  await expect(runDspyOptimization(options)).rejects.toThrow('interrupted generation');
  options.checkpoint.resume = true;
  let restored: unknown;
  options.onRestore = async evidence => { restored = evidence; };
  const report = await runDspyOptimization(options);
  expect(report.provenance).toMatchObject({ proposals: 1, evaluations: 4, selectedCandidateIndex: 1 });
  expect(generations).toHaveLength(1);
  expect(restored).toMatchObject({ failedAttempts: [attempt], reservations: expect.arrayContaining([
    { id: 'call-3', method: 'generate', attempts: 1, settledAttempts: 1, completed: false } ]) });
  expect(JSON.stringify(restored)).not.toContain('currentComponents');
  const again = await runDspyOptimization(options);
  expect(again).toEqual(report);
  expect(generations).toHaveLength(1);
  expect(restored).toMatchObject({ reservations: expect.arrayContaining([
    { id: 'call-3', method: 'generate', attempts: 2, settledAttempts: 2, completed: true } ]) });
});
