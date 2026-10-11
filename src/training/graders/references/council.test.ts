import { describe, expect, it, vi } from 'vitest';
import type { InferenceProvider, InferenceRequest } from '../../contracts/index.js';
import type { CheckInstance } from '../decomposition/index.js';
import { runCouncil } from './council.js';
import type { CouncilOptions, CouncilOutput } from './types.js';

function instance(id = 'a', projection: Record<string, unknown> = { text: 'exact evidence' }): CheckInstance {
  return { id, template_id: 'support', unit_id: id, type: 'choice', instructions: 'Support?',
    criteria: { yes: 'yes', no: 'no' }, options: ['yes', 'no'], expected: ['yes'], projection, digest: id, status: 'ready', reasons: [] };
}
function provider(answer: string, hook?: (request: InferenceRequest) => string): InferenceProvider {
  return { id: answer, capabilities: { billing: 'subscription', tools: 'disabled', seed: false, temperature: false },
    generate: vi.fn(async request => {
      const payload = JSON.parse(request.prompt) as { questions: { check_id: string }[] };
      return { text: hook ? hook(request) : JSON.stringify(Object.fromEntries(payload.questions.map(q => [q.check_id, { answer }]))),
        model: 'reported', route: 'subscription', usage: null };
    }) };
}
function setup(): CouncilOptions {
  return { outputDigest: 'output', instances: [instance()], teachers: [
    { id: 'c', provider: 'codex', model: 'model-c' }, { id: 'a', provider: 'claude', model: 'model-a' }],
  providers: { c: provider('yes'), a: provider('yes') }, now: new Date('2026-10-11T12:00:00Z') };
}
describe('independent council execution', () => {
  it('batches each teacher by exact projection, retains missing instances and checkpoints', async () => {
    const options = setup(); options.instances.push(instance('b'), instance('c', { other: 'projection' }), { ...instance('missing'), status: 'missing' });
    const checkpoint = vi.fn(); options.onCheckpoint = checkpoint;
    const output = await runCouncil(options);
    expect(output.calls).toHaveLength(4); expect(output.checks.a!.status).toBe('agreed');
    expect(output.checks.a!.distribution).toEqual({ yes: 1, no: 0 });
    expect(output.checks.missing).toMatchObject({ final: null, status: 'uncertain', unknown_mass: 1 });
    expect(output.calls.every(call => call.wallMs >= 0 && call.prompt_digest.length === 64)).toBe(true);
    expect(checkpoint).toHaveBeenCalledWith(output);
    const resumed = await runCouncil({ ...options, previous: output });
    expect(resumed).toBe(output); expect(options.providers.c!.generate).toHaveBeenCalledTimes(2);
    await expect(runCouncil({ ...options, outputDigest: 'different', previous: output })).rejects.toThrow('Stale');
  });
  it('adjudicates disagreements once plus one fresh reversed-order probe, without teacher identities', async () => {
    const options = setup(); options.providers.a = provider('no');
    const result = await runCouncil(options);
    expect(result.calls.map(call => call.phase)).toEqual(['teacher', 'teacher', 'adjudication', 'adjudication']);
    expect(result.checks.a).toMatchObject({ distribution: { yes: 0.5, no: 0.5 }, final: null, status: 'uncertain' });
    const prompts = vi.mocked(options.providers.c!.generate).mock.calls.map(([request]) => JSON.parse(request.prompt));
    const first = prompts[1].questions[0].competing, second = prompts[2].questions[0].competing;
    expect(first).toEqual([...second].reverse());
    expect(first.every((vote: object) => Object.keys(vote).join() === 'answer')).toBe(true);
    expect(prompts[1].questions[0].evidence).toEqual({ text: 'exact evidence' });
  });
  it('retains unstable and uncertain adjudications without promoting either answer', async () => {
    const options = setup(); let count = 0;
    options.providers.c = provider('yes', () => JSON.stringify({ a: { answer: ++count === 3 ? 'no' : 'yes' } }));
    options.providers.a = provider('abstain');
    const output = await runCouncil(options);
    expect(output.checks.a).toMatchObject({ final: null, status: 'uncertain', adjudication: [{ answer: 'yes' }, { answer: 'no' }] });
    const uncertain = setup(); uncertain.providers.a = provider('abstain');
    uncertain.providers.c = provider('yes', request => JSON.stringify({ a: { answer: request.system!.includes('Adversarially') ? 'uncertain' : 'yes' } }));
    expect((await runCouncil(uncertain)).checks.a!.final).toBeNull();
  });
  it('does not call zero-confidence unanimity agreed', async () => {
    const options = setup();
    options.providers.c = options.providers.a = provider('yes', () => '{"a":{"answer":"yes","p":0}}');
    const output = await runCouncil(options);
    expect(output.checks.a).toMatchObject({ final: null, status: 'uncertain', unknown_mass: 1 });
  });
  it('retains failed/invalid call accounting and never invents actual model identity', async () => {
    const options = setup();
    options.providers.c = provider('yes');
    vi.mocked(options.providers.c.generate).mockResolvedValue({ text: 'invalid', model: 'assumed', modelBasis: 'requested-assumption', usage: null, route: 'r', attempts: [] });
    vi.mocked(options.providers.a!.generate).mockRejectedValue({ responseModel: 'actual', responseRoute: 'failure-route', usage: { costUsd: 1 }, attempts: [] });
    const output = await runCouncil(options);
    expect(output.calls[0]).toMatchObject({ outcome: 'invalid-response', reportedModel: null, attempts: [] });
    expect(output.calls[1]).toMatchObject({ outcome: 'generation-error', reportedModel: 'actual', route: 'failure-route', usage: { costUsd: 1 } });
    expect(output.checks.a).toMatchObject({ unknown_mass: 1, final: null });
    vi.mocked(options.providers.a!.generate).mockRejectedValue('failure');
    expect((await runCouncil(options)).calls[1]!.usage).toBeNull();
    vi.mocked(options.providers.a!.generate).mockRejectedValue(new Error('failure'));
    expect((await runCouncil(options)).calls[1]!.reportedModel).toBeNull();
  });
  it('reports Grok skipped outside window and includes it inside window', async () => {
    const options = setup(); options.teachers.push({ id: 'g', provider: 'grok', model: 'g' });
    options.providers.g = provider('yes');
    const outside = await runCouncil(options);
    expect(outside.skipped[0]!.reason).toContain('Outside Grok window'); expect(options.providers.g.generate).not.toHaveBeenCalled();
    const inside = await runCouncil({ ...options, now: new Date('2026-10-11T21:00:00Z') });
    expect(inside.skipped).toEqual([]); expect(inside.calls).toHaveLength(3);
    await expect(runCouncil({ ...options, providers: {}, previous: inside })).rejects.toThrow('Stale');
    expect(await runCouncil({ ...options, now: new Date('2026-10-11T21:00:00Z'), providers: {}, previous: inside })).toBe(inside);
  });
  it('checks the window again before every Grok call', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-12T04:29:00Z'));
    try {
      const options = setup(); delete options.now;
      options.teachers.push({ id: 'g', provider: 'grok', model: 'g' }); options.providers.g = provider('yes');
      options.providers.c = provider('yes', () => { vi.setSystemTime(new Date('2026-10-12T04:30:00Z')); return '{"a":{"answer":"yes"}}'; });
      const output = await runCouncil(options);
      expect(options.providers.g.generate).not.toHaveBeenCalled(); expect(output.skipped[0]!.reason).toContain('closed before');
      expect(output.checks.a!.teachers.g).toEqual({ answer: null, status: 'missing' });
    } finally { vi.useRealTimers(); }
  });
  it('propagates abort rather than completing or dispatching further calls', async () => {
    const options = setup(), controller = new AbortController(); options.signal = controller.signal;
    options.providers.c = provider('yes', () => { controller.abort(); throw controller.signal.reason; });
    await expect(runCouncil(options)).rejects.toThrow(); expect(options.providers.a!.generate).not.toHaveBeenCalled();
    await expect(runCouncil(options)).rejects.toThrow();
  });
  it('refuses unsafe provider routes, duplicate IDs, missing mandatory teachers and invalid settings', async () => {
    const options = setup();
    await expect(runCouncil({ ...options, teachers: [] })).rejects.toThrow('IDs');
    await expect(runCouncil({ ...options, teachers: [options.teachers[0]!, options.teachers[0]!] })).rejects.toThrow('IDs');
    await expect(runCouncil({ ...options, teachers: [options.teachers[0]!] })).rejects.toThrow('codex and claude');
    await expect(runCouncil({ ...options, instances: [instance(), instance()] })).rejects.toThrow('Duplicate check');
    await expect(runCouncil({ ...options, adjudicator: 'unknown' })).rejects.toThrow('Adjudicator');
    await expect(runCouncil({ ...options, timeoutMs: 0 })).rejects.toThrow('timeout');
    await expect(runCouncil({ ...options, providers: {} })).rejects.toThrow('subscription');
    options.providers.c!.capabilities.billing = 'api';
    await expect(runCouncil(options)).rejects.toThrow('subscription');
    options.providers.c!.capabilities.billing = 'subscription'; options.providers.c!.capabilities.tools = 'enabled' as 'disabled';
    await expect(runCouncil(options)).rejects.toThrow('subscription');
  });
});


describe('durable council call progress', () => {
  it('retains completed and cancelled teacher receipts, resuming only the missing response', async () => {
    const options = setup(), controller = new AbortController();
    let saved: CouncilOutput | undefined;
    options.onCheckpoint = output => { saved = output; };
    const original = options.providers.a!.generate;
    options.providers.a!.generate = vi.fn(async () => {
      controller.abort();
      throw { usage: { costUsd: 1 }, responseModel: 'actual', responseRoute: 'subscription', attempts: [] };
    });
    await expect(runCouncil({ ...options, signal: controller.signal })).rejects.toThrow();
    expect(saved!.complete).toBe(false);
    expect(saved!.calls.map(call => call.outcome)).toEqual(['completed', 'cancelled']);
    expect(saved!.calls[1]).toMatchObject({ usage: { costUsd: 1 }, reportedModel: 'actual', attempts: [] });
    options.providers.a!.generate = original;
    const result = await runCouncil({ ...options, previous: saved });
    expect(result.complete).toBe(true); expect(result.checks.a!.final).toBe('yes');
    expect(options.providers.c!.generate).toHaveBeenCalledTimes(1);
    expect(original).toHaveBeenCalledTimes(1); expect(result.calls).toHaveLength(3);
  });
  it('persists responses before decoding and recovers an interrupted adjudication without repeating calls', async () => {
    const options = setup(); options.providers.a = provider('no');
    let saved: CouncilOutput | undefined;
    options.onCheckpoint = output => {
      saved = output;
      if (output.calls.at(-1)?.phase === 'adjudication' && output.calls.at(-1)?.outcome === 'received') throw new Error('interrupted write');
    };
    await expect(runCouncil(options)).rejects.toThrow('interrupted write');
    expect(saved!.calls.at(-1)).toMatchObject({ outcome: 'received', response_text: '{"a":{"answer":"yes"}}' });
    const result = await runCouncil({ ...options, previous: saved, onCheckpoint: undefined });
    expect(result.calls).toHaveLength(4); expect(result.checks.a!.adjudication).toHaveLength(2);
    expect(options.providers.c!.generate).toHaveBeenCalledTimes(3);
    expect(options.providers.a!.generate).toHaveBeenCalledTimes(1);
  });
  it('retains a successful response when cancellation arrives with it', async () => {
    const options = setup(), controller = new AbortController();
    let saved: CouncilOutput | undefined;
    options.onCheckpoint = output => { saved = output; };
    options.providers.c = provider('yes', () => { controller.abort(); return '{"a":{"answer":"yes"}}'; });
    await expect(runCouncil({ ...options, signal: controller.signal })).rejects.toThrow();
    expect(saved!.calls[0]!.outcome).toBe('received');
    const result = await runCouncil({ ...options, previous: saved });
    expect(result.checks.a!.final).toBe('yes'); expect(options.providers.c.generate).toHaveBeenCalledTimes(1);
  });
});

it('selects the default adjudicator after filtering inactive Grok teachers', async () => {
  const options = setup();
  options.teachers.unshift({ id: 'g', provider: 'grok', model: 'g' });
  options.providers.g = provider('yes'); options.providers.a = provider('no');
  const result = await runCouncil(options);
  expect(result.calls.filter(call => call.phase === 'adjudication').every(call => call.teacher === 'c')).toBe(true);
  expect(options.providers.g.generate).not.toHaveBeenCalled();
});
it('requires another independent teacher to support the adjudicated final', async () => {
  const options = setup();
  options.providers.a = provider('abstain');
  expect((await runCouncil(options)).checks.a!.final).toBeNull();
  options.providers.a = provider('no');
  options.providers.c = provider('yes', request => JSON.stringify({ a: { answer: request.system!.includes('Adversarially') ? 'no' : 'yes' } }));
  expect((await runCouncil(options)).checks.a).toMatchObject({ final: 'no', status: 'adjudicated' });
});
it.each(['invalid-response', 'generation-error'] as const)('retries %s receipts on incomplete resume, retaining earlier accounting', async outcome => {
  const options = setup(); let saved: CouncilOutput | undefined;
  if (outcome === 'invalid-response') options.providers.c = provider('yes', () => 'invalid');
  else vi.mocked(options.providers.c!.generate).mockRejectedValue(new Error('offline'));
  options.onCheckpoint = output => {
    saved = output;
    if (output.calls[0]?.outcome === outcome) throw new Error('interrupt');
  };
  await expect(runCouncil(options)).rejects.toThrow('interrupt');
  options.providers.c = provider('yes');
  const result = await runCouncil({ ...options, previous: saved, onCheckpoint: undefined });
  expect(result.checks.a!.final).toBe('yes');
  expect(result.calls.map(call => call.outcome)).toEqual([outcome, 'completed', 'completed']);
  expect(result.shuffle_secret).toBe(saved!.shuffle_secret);
});
it('pins the resolved window state on incomplete as well as complete resumes', async () => {
  const options = setup(); let saved: CouncilOutput | undefined;
  options.onCheckpoint = output => { saved = output; throw new Error('interrupt'); };
  await expect(runCouncil(options)).rejects.toThrow('interrupt');
  await expect(runCouncil({ ...options, previous: saved, now: new Date('2026-10-11T21:00:00Z') })).rejects.toThrow('Stale');
});
it('uses a private run secret, strips peer probabilities, retains spans and rotates odd panels', async () => {
  const options = setup(); options.now = new Date('2026-10-11T21:00:00Z');
  options.teachers.push({ id: 'g', provider: 'grok', model: 'g' });
  options.providers.g = provider('abstain');
  options.providers.a = provider('no', () => '{"a":{"answer":"no","p":0.8,"span":"exact evidence"}}');
  const first = await runCouncil(options), second = await runCouncil(options);
  expect(first.shuffle_secret).toMatch(/^[a-f0-9]{64}$/);
  expect(second.shuffle_secret).not.toBe(first.shuffle_secret);
  const prompts = vi.mocked(options.providers.c!.generate).mock.calls.slice(0, 3).map(([request]) => request.prompt);
  expect(prompts.join()).not.toContain(first.shuffle_secret);
  const a = JSON.parse(prompts[1]!).questions[0].competing;
  const b = JSON.parse(prompts[2]!).questions[0].competing;
  expect(a).toContainEqual({ answer: 'no', span: 'exact evidence' });
  expect(a.every((vote: object) => !Object.hasOwn(vote, 'p'))).toBe(true);
  expect(b).toEqual([...a.slice(1), a[0]]);
  for (let i = 0; i < a.length; i++) expect(b[i]).not.toEqual(a[i]);
});

it('keeps failed teachers distinct from authored missing labels even when adjudication chooses them', async () => {
  const options = setup();
  options.instances[0]!.criteria = { present: 'Present', missing: 'Absent' };
  options.instances[0]!.options = ['present', 'missing'];
  options.providers.c = provider('missing', request => {
    if (!request.system!.includes('Adversarially')) throw new Error('offline');
    return '{"a":{"answer":"missing"}}';
  });
  vi.mocked(options.providers.a!.generate).mockRejectedValue(new Error('offline'));
  const result = await runCouncil(options);
  expect(result.checks.a).toMatchObject({ final: null, status: 'uncertain', unknown_mass: 1,
    distribution: { present: 0, missing: 0 }, teachers: {
      c: { answer: null, status: 'missing' }, a: { answer: null, status: 'missing' },
    } });
  expect(result.calls.filter(call => call.phase === 'adjudication')).toHaveLength(2);
});
it('cannot promote abstentions to an authored answer or adjudicated final', async () => {
  const options = setup();
  options.instances[0]!.criteria = { yes: 'Yes', abstain: 'Legacy label' };
  options.instances[0]!.options = ['yes', 'abstain'];
  options.providers.a = provider('abstain');
  options.providers.c = provider('abstain');
  const result = await runCouncil(options);
  expect(result.checks.a).toMatchObject({ final: null, unknown_mass: 1, status: 'uncertain' });
  expect(result.checks.a!.teachers.a).toEqual({ answer: null, status: 'abstain' });
});
