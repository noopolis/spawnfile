import { expect, it, vi } from 'vitest';
import type { InferenceProvider, InferenceRequest } from '../../contracts/index.js';
import type { CheckInstance } from '../decomposition/index.js';
import { stableDigest } from '../format/index.js';
import { runCouncil } from './council.js';
import { councilContentDigest, defaultGrokWindow } from './policy.js';
import { councilPromptVersion } from './protocol.js';
import type { CouncilOptions, CouncilOutput } from './types.js';

function setup(count = 100): CouncilOptions {
  const instances: CheckInstance[] = Array.from({ length: count }, (_, n) => ({
    id: `check-${n}`, template_id: 'support', unit_id: `unit-${n}`, type: 'choice',
    instructions: `Support ${n}?`, criteria: { yes: 'Supported', no: 'Unsupported' },
    options: ['yes', 'no'], expected: ['yes'], projection: { text: `Evidence ${n}` },
    digest: String(n), status: 'ready', reasons: [],
  }));
  const teachers = [{ id: 'c', provider: 'codex', model: 'c' }, { id: 'a', provider: 'claude', model: 'a' }];
  const providers = Object.fromEntries(teachers.map(teacher => [teacher.id, {
    id: teacher.id, capabilities: { billing: 'subscription', tools: 'disabled', seed: false, temperature: false },
    generate: vi.fn(async request => response(request)),
  } satisfies InferenceProvider]));
  return { outputDigest: 'output', instances, teachers, providers, now: new Date('2026-10-11T12:00:00Z') };
}
function response(request: InferenceRequest, answer = 'yes') {
  const { questions } = JSON.parse(request.prompt) as { questions: { key: string }[] };
  return { text: JSON.stringify(Object.fromEntries(questions.map(q => [q.key, { answer }]))),
    model: request.model, route: 'subscription', usage: null };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it('sends 100 distinct projections in ordered 40/40/20 batches per teacher, each with its own evidence', async () => {
  const options = setup();
  const result = await runCouncil(options);
  expect(result.calls).toHaveLength(6);
  for (const provider of Object.values(options.providers)) {
    const requests = vi.mocked(provider.generate).mock.calls.map(([request]) => JSON.parse(request.prompt));
    expect(requests.map(request => request.questions.length)).toEqual([40, 40, 20]);
    const questions = requests.flatMap(request => request.questions);
    expect(requests.map(request => request.questions.map((q: { key: string }) => q.key)))
      .toEqual([40, 40, 20].map(count => Array.from({ length: count }, (_, index) => `q${index + 1}`)));
    expect(questions.map(q => q.evidence)).toEqual(options.instances.map(instance => instance.projection));
    expect(requests.every(request => Object.keys(request).join() === 'questions')).toBe(true);
    expect(questions.every(q => !Object.hasOwn(q, 'competing'))).toBe(true);
  }
  expect(Object.values(result.checks).every(check => check.final === 'yes')).toBe(true);
});

it('runs teachers concurrently with one call each in flight and a barrier before bounded adjudication', async () => {
  const options = setup(5); options.batchSize = 2;
  const slow = deferred(), started = deferred(), fastFinished = deferred();
  let active = 0, peak = 0, aCalls = 0, cCalls = 0;
  options.providers.a!.generate = vi.fn(async request => {
    aCalls++;
    if (aCalls === 1) { started.resolve(); await slow.promise; }
    return response(request, 'no');
  });
  options.providers.c!.generate = vi.fn(async request => {
    expect(active++).toBe(0); peak = Math.max(peak, active);
    const adjudication = request.system!.includes('Adversarially');
    if (adjudication) expect(aCalls).toBe(3);
    else if (++cCalls === 3) fastFinished.resolve();
    await Promise.resolve(); active--;
    return response(request, adjudication ? 'no' : 'yes');
  });
  const pending = runCouncil(options);
  await Promise.all([started.promise, fastFinished.promise]);
  expect(aCalls).toBe(1); expect(cCalls).toBe(3);
  expect(vi.mocked(options.providers.c!.generate).mock.calls.every(([r]) => !r.system!.includes('Adversarially'))).toBe(true);
  slow.resolve();
  const result = await pending;
  expect(peak).toBe(1);
  expect(result.calls.filter(call => call.phase === 'adjudication').map(call => call.check_ids.length)).toEqual([2, 2, 1, 2, 2, 1]);
  expect(Object.values(result.checks).every(check => check.final === 'no' && check.adjudication.length === 2)).toBe(true);
});

it('serializes immutable checkpoint snapshots and resumes received calls without regenerating them', async () => {
  const options = setup(100), blockedWrite = deferred(), firstWrite = deferred();
  let saved: CouncilOutput | undefined, writing = false, writes = 0;
  options.onCheckpoint = async output => {
    expect(writing).toBe(false); writing = true;
    const before = JSON.stringify(output);
    if (++writes === 1) { firstWrite.resolve(); await blockedWrite.promise; }
    expect(JSON.stringify(output)).toBe(before);
    const { digest, ...content } = output;
    expect(digest).toBe(councilContentDigest(content));
    saved = output; writing = false;
  };
  const controller = new AbortController();
  const pending = runCouncil({ ...options, signal: controller.signal });
  const rejected = expect(pending).rejects.toThrow();
  await firstWrite.promise;
  expect(Object.values(options.providers).map(provider => vi.mocked(provider.generate).mock.calls.length)).toEqual([1, 1]);
  controller.abort(); blockedWrite.resolve(); await rejected;
  expect(saved!.calls).toHaveLength(2);
  expect(saved!.calls.every(call => call.outcome === 'received')).toBe(true);
  const original = structuredClone(saved!.calls);
  const result = await runCouncil({ ...options, previous: saved });
  expect(result.calls).toHaveLength(6);
  expect(result.complete).toBe(true);
  for (const provider of Object.values(options.providers)) expect(provider.generate).toHaveBeenCalledTimes(3);
  for (const call of original) expect(result.calls.find(item => item.id === call.id)).toMatchObject({
    at: call.at, wallMs: call.wallMs, usage: call.usage, outcome: 'completed',
  });
  await runCouncil({ ...options, previous: result });
  for (const provider of Object.values(options.providers)) expect(provider.generate).toHaveBeenCalledTimes(3);
});

it('drains in-flight teachers after a checkpoint failure and starts no more batches or adjudication', async () => {
  const options = setup(100), slow = deferred(), failedWrite = deferred();
  options.providers.a!.generate = vi.fn(async request => { await slow.promise; return response(request); });
  options.onCheckpoint = () => { failedWrite.resolve(); throw new Error('disk failure'); };
  let settled = false;
  const pending = runCouncil(options).finally(() => { settled = true; });
  const rejected = expect(pending).rejects.toThrow('disk failure');
  await failedWrite.promise;
  await Promise.resolve();
  expect(settled).toBe(false);
  slow.resolve(); await rejected;
  for (const provider of Object.values(options.providers)) expect(provider.generate).toHaveBeenCalledTimes(1);
});

it('pins batch size and the v7 protocol and refuses v6 checkpoint reuse', async () => {
  const options = setup(1), result = await runCouncil(options);
  expect(councilPromptVersion).toBe('paideia.council.v7');
  await expect(runCouncil({ ...options, previous: result, batchSize: 1 })).rejects.toThrow('Stale');
  const identity = stableDigest({ version: 'paideia.council.v6', output: options.outputDigest,
    instances: options.instances, teachers: options.teachers, batchSize: 40, adjudicator: 'c', window: defaultGrokWindow,
    windowOpen: false, active: ['c', 'a'], seed: 'paideia.council', timeoutMs: 120_000 });
  const { digest: _digest, ...old } = { ...result, identity };
  await expect(runCouncil({ ...options, previous: { ...old, digest: councilContentDigest(old) } })).rejects.toThrow('Stale');
});

it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])('refuses invalid batch size %s before inference', async batchSize => {
  const options = setup(1);
  await expect(runCouncil({ ...options, batchSize })).rejects.toThrow('batch size');
  for (const provider of Object.values(options.providers)) expect(provider.generate).not.toHaveBeenCalled();
});


it.each([false, true])('keeps identical batches bound to their check IDs across interrupted resume (disputed=%s)', async disputed => {
  const options = setup(3); options.batchSize = 1;
  options.instances = options.instances.map(instance => ({ ...instance,
    instructions: 'Supported?', projection: { text: 'Same evidence' } }));
  if (disputed) options.providers.a!.generate = vi.fn(async request => response(request, 'no'));
  if (disputed) options.providers.c!.generate = vi.fn(async request =>
    response(request, request.system!.includes('Adversarially') ? 'no' : 'yes'));
  const controller = new AbortController();
  let saved: CouncilOutput | undefined;
  options.onCheckpoint = output => {
    saved = output;
    if (output.calls.some(call => call.outcome === 'completed')) controller.abort();
  };
  await expect(runCouncil({ ...options, signal: controller.signal })).rejects.toThrow();
  expect(saved!.calls.some(call => call.outcome === 'completed')).toBe(true);
  const result = await runCouncil({ ...options, onCheckpoint: undefined, previous: saved });
  expect(result.calls).toHaveLength(disputed ? 12 : 6);
  expect(new Set(result.calls.map(call => call.id)).size).toBe(result.calls.length);
  expect(new Set(result.calls.filter(call => call.teacher === 'c' && call.phase === 'teacher')
    .map(call => call.prompt_digest)).size).toBe(1);
  for (const instance of options.instances) {
    expect(result.checks[instance.id]).toMatchObject({
      final: disputed ? 'no' : 'yes', status: disputed ? 'adjudicated' : 'agreed',
      teachers: { c: { answer: 'yes' }, a: { answer: disputed ? 'no' : 'yes' } },
    });
  }
  expect(options.providers.a!.generate).toHaveBeenCalledTimes(3);
  expect(options.providers.c!.generate).toHaveBeenCalledTimes(disputed ? 9 : 3);
  expect(await runCouncil({ ...options, onCheckpoint: undefined, previous: result })).toEqual(result);
  expect(options.providers.a!.generate).toHaveBeenCalledTimes(3);
  expect(options.providers.c!.generate).toHaveBeenCalledTimes(disputed ? 9 : 3);
});

it.each(['unit_id', 'template_id', 'digest', 'projection', 'status'] as const)(
  'refuses resume when full check identity changes: %s', async field => {
    const options = setup(2);
    options.instances = options.instances.map(i => ({ ...i, instructions: 'Supported?', projection: { text: 'Same evidence' } }));
    const result = await runCouncil(options);
    const instances = structuredClone(options.instances);
    Object.assign(instances[0]!, { [field]: field === 'projection' ? { text: 'New state' } : field === 'status' ? 'missing' : 'changed' });
    await expect(runCouncil({ ...options, instances, previous: result })).rejects.toThrow('Stale');
    for (const provider of Object.values(options.providers)) expect(provider.generate).toHaveBeenCalledTimes(1);
  },
);

it.each(['unit_id', 'template_id', 'digest'] as const)(
  'gives identical prompts distinct call identities when %s changes', async field => {
    const options = setup(1);
    const original = await runCouncil(options);
    const instances = structuredClone(options.instances);
    instances[0]![field] = 'changed';
    const changed = await runCouncil({ ...options, instances });
    expect(changed.calls.map(call => call.prompt_digest)).toEqual(original.calls.map(call => call.prompt_digest));
    for (const call of changed.calls) {
      expect(original.calls.some(previous => previous.id === call.id)).toBe(false);
      expect(call.answers).toEqual({ 'check-0': { answer: 'yes' } });
    }
    for (const provider of Object.values(options.providers)) expect(provider.generate).toHaveBeenCalledTimes(2);
  },
);
