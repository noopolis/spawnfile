import { describe, expect, it, vi } from 'vitest';
import type { InferenceProvider, InferenceRequest } from '../../contracts/index.js';
import type { CheckInstance } from '../decomposition/index.js';
import { runCouncil } from './council.js';
import type { CouncilOptions } from './types.js';

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
    expect(result.checks.a).toMatchObject({ distribution: { yes: 0.5, no: 0.5 }, final: 'yes', status: 'adjudicated' });
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
    expect(await runCouncil({ ...options, providers: {}, previous: inside })).toBe(inside);
  });
  it('checks the window again before every Grok call', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-12T04:29:00Z'));
    try {
      const options = setup(); delete options.now;
      options.teachers.push({ id: 'g', provider: 'grok', model: 'g' }); options.providers.g = provider('yes');
      options.providers.c = provider('yes', () => { vi.setSystemTime(new Date('2026-10-12T04:30:00Z')); return '{"a":{"answer":"yes"}}'; });
      const output = await runCouncil(options);
      expect(options.providers.g.generate).not.toHaveBeenCalled(); expect(output.skipped[0]!.reason).toContain('closed before');
      expect(output.checks.a!.teachers.g).toEqual({ answer: 'missing' });
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
