import type { InferenceFailureKind } from '../../contracts/index.js';
import { randomBytes } from 'node:crypto';
import { stableDigest } from '../format/index.js';
import type { CheckInstance } from '../decomposition/index.js';
import { averageAnswers, councilContentDigest, defaultGrokWindow, grokWindowOpen, reusableCouncil } from './policy.js';
import { councilPrompt, councilPromptVersion, decodeCouncilAnswers } from './protocol.js';
import type { CouncilOptions, CouncilOutput, CouncilTeacher, ReferenceCall, TeacherAnswer } from './types.js';

export async function runCouncil(options: CouncilOptions): Promise<CouncilOutput> {
  const { instances, teachers, providers } = options;
  if (new Set(teachers.map(t => t.id)).size !== teachers.length || !teachers.length) throw new Error('Council teacher IDs must be unique and nonempty');
  if (!['codex', 'claude'].every(provider => teachers.some(teacher => teacher.provider === provider))) {
    throw new Error('Council requires independent codex and claude teachers');
  }
  if (new Set(instances.map(i => i.id)).size !== instances.length) throw new Error('Duplicate check IDs');
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error('Invalid council timeout');
  const batchSize = options.batchSize ?? 40;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error('Invalid council batch size');
  const window = options.grokWindow ?? defaultGrokWindow;
  const now = options.now ?? new Date();
  const windowOpen = grokWindowOpen(now, window);
  const skipped = teachers.filter(t => t.provider === 'grok' && !windowOpen)
    .map(t => ({ teacher: t.id, reason: `Outside Grok window ${window.start}-${window.end} ${window.timeZone ?? 'Europe/Berlin'}` }));
  const active = teachers.filter(t => !skipped.some(s => s.teacher === t.id));
  const adjudicator = options.adjudicator ? active.find(t => t.id === options.adjudicator) : active[0];
  if (!adjudicator) throw new Error('Adjudicator is not an active teacher');
  const identity = stableDigest({ version: councilPromptVersion, output: options.outputDigest,
    instances, teachers, batchSize, adjudicator: adjudicator.id, window, windowOpen, active: active.map(t => t.id),
    seed: options.seed ?? 'paideia.council', timeoutMs: options.timeoutMs ?? 120_000 });
  if (options.previous) {
    const { digest, ...content } = options.previous;
    if (content.identity !== identity || digest !== councilContentDigest(content)) throw new Error('Stale or corrupt council checkpoint');
    if (reusableCouncil(options.previous, identity)) return options.previous;
  }
  const shuffleSecret = options.previous?.shuffle_secret ?? randomBytes(32).toString('hex');
  for (const teacher of active) {
    const provider = providers[teacher.id];
    if (!provider || provider.capabilities.billing !== 'subscription' || !['disabled', 'contained'].includes(provider.capabilities.tools)) {
      throw new Error(`Council teacher ${teacher.id} requires tool-isolated subscription inference`);
    }
  }
  const calls: ReferenceCall[] = structuredClone(options.previous?.calls ?? []);
  const checks: CouncilOutput['checks'] = Object.fromEntries(instances.map(instance => [instance.id, {
    ready: instance.status === 'ready', digest: instance.digest, template_id: instance.template_id, teachers: {},
    distribution: {}, unknown_mass: 1, adjudication: [], final: null, status: 'uncertain',
  }]));
  let writes = Promise.resolve();
  const checkpoint = async (complete = false) => {
    const content: Omit<CouncilOutput, 'digest'> = structuredClone({ outputDigest: options.outputDigest, identity, complete, checks, calls, skipped,
      shuffle_secret: shuffleSecret, active_teachers: active.map(teacher => teacher.id) });
    const output = { ...content, digest: councilContentDigest(content) };
    writes = writes.then(() => options.onCheckpoint?.(output));
    await writes;
    return output;
  };
  const invoke = async (teacher: CouncilTeacher, batch: CheckInstance[], competing?: Record<string, TeacherAnswer[]>, run?: number) => {
    options.signal?.throwIfAborted();
    const prompt = councilPrompt(batch, competing);
    const id = stableDigest([identity, teacher.id, prompt.digest, batch.map(instance => instance.id), run ?? null]);
    const existing = calls.findLast(call => call.id === id && ['received', 'completed'].includes(call.outcome));
    if (existing && existing.outcome !== 'received') return existing.answers ?? null;
    if (!existing && teacher.provider === 'grok' && !grokWindowOpen(options.now ?? new Date(), window)) {
      if (!skipped.some(item => item.teacher === teacher.id)) skipped.push({ teacher: teacher.id,
        reason: `Grok window closed before ${competing ? 'adjudication' : 'teacher'} call` });
      return null;
    }
    const start = performance.now();
    const call: ReferenceCall = existing ?? { id,
      teacher: teacher.id, provider: teacher.provider, requestedModel: teacher.model, reportedModel: null, route: null,
      prompt_digest: prompt.digest, phase: competing ? 'adjudication' : 'teacher', ...(run === undefined ? {} : { run }),
      check_ids: batch.map(i => i.id), at: new Date().toISOString(), wallMs: 0, usage: null, outcome: 'generation-error' };
    if (!existing) {
      try {
        const response = await providers[teacher.id]!.generate({ model: teacher.model, system: prompt.system,
          prompt: prompt.prompt, responseSchema: prompt.schema, responseJsonFence: true, signal: AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 120_000), ...(options.signal ? [options.signal] : [])]) });
        call.reportedModel = response.modelBasis === 'requested-assumption' ? null : response.model;
        call.route = response.route; call.usage = response.usage;
        if (response.attempts) call.attempts = response.attempts;
        call.response_text = response.text; call.outcome = 'received';
      } catch (error) {
        call.failure_class = 'unknown';
        if (error !== null && typeof error === 'object') {
          const failure = error as Partial<ReferenceCall> & { responseModel?: string; responseRoute?: string; kind?: InferenceFailureKind };
          if (failure.kind && ['quota', 'transport', 'unavailable', 'authentication', 'auth-stale', 'protocol',
            'invalid-response', 'cancelled', 'timeout', 'unsupported', 'unknown'].includes(failure.kind)) call.failure_class = failure.kind;
          if (failure.diagnostic) call.diagnostic = failure.diagnostic;
          call.usage = failure.usage ?? null;
          call.reportedModel = failure.responseModel ?? null; call.route = failure.responseRoute ?? null;
          if (failure.attempts) call.attempts = failure.attempts;
        }
        if (options.signal?.aborted) call.outcome = 'cancelled';
      }
      call.wallMs = performance.now() - start; calls.push(call);
      // Commit the actual provider receipt before parsing or observing cancellation.
      await checkpoint();
      options.signal?.throwIfAborted();
    }
    const answers = call.response_text === undefined ? null : decodeCouncilAnswers(call.response_text, batch, competing !== undefined);
    call.answers = answers;
    if (call.outcome === 'received') {
      call.outcome = answers ? 'completed' : 'invalid-response';
      if (!answers) call.failure_class = 'invalid-response';
    }
    await checkpoint();
    return answers;
  };
  const ready = instances.filter(instance => instance.status === 'ready');
  const batches: CheckInstance[][] = [];
  for (let offset = 0; offset < ready.length; offset += batchSize) batches.push(ready.slice(offset, offset + batchSize));
  // Each teacher has one serial queue. Drain all queues before adjudication or failure.
  const independent = await Promise.allSettled(active.map(async teacher => {
    for (const batch of batches) {
      await writes;
      const answers = await invoke(teacher, batch);
      for (const instance of batch) checks[instance.id]!.teachers[teacher.id] = answers?.[instance.id] ?? { answer: null, status: 'missing' };
    }
  }));
  const failure = independent.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  const disputed: CheckInstance[] = [];
  for (const instance of instances) {
    const check = checks[instance.id]!;
    for (const teacher of active) check.teachers[teacher.id] ??= { answer: null, status: 'missing' };
    const answers = Object.values(check.teachers);
    Object.assign(check, averageAnswers(instance.options, answers));
    if (instance.status !== 'ready') continue;
    if (answers.length > 0 && answers.every(a => a.answer !== null && a.answer === answers[0]!.answer && Object.hasOwn(instance.criteria, a.answer) && (a.p ?? 1) > 0)) {
      check.final = answers[0]!.answer; check.status = 'agreed';
    } else disputed.push(instance);
  }
  if (disputed.length) {
    // A private run secret hides teacher order; the repeat moves every panel position.
    const competing = Object.fromEntries(disputed.map(instance => [instance.id,
      active.map(teacher => ({ key: stableDigest([shuffleSecret, instance.id, teacher.id]),
        vote: checks[instance.id]!.teachers[teacher.id]! })).sort((a, b) => a.key.localeCompare(b.key)).map(item => item.vote)]));
    for (const run of [0, 1]) {
      const ordered = run === 0 ? competing : Object.fromEntries(Object.entries(competing).map(([id, votes]) => [id, votes.length % 2 ? [...votes.slice(1), votes[0]!] : [...votes].reverse()]));
      for (let offset = 0; offset < disputed.length; offset += batchSize) {
        const batch = disputed.slice(offset, offset + batchSize);
        const answers = await invoke(adjudicator, batch, ordered, run);
        for (const instance of batch) checks[instance.id]!.adjudication.push(answers?.[instance.id] ?? { answer: null, status: 'uncertain' });
      }
    }
    for (const instance of disputed) {
      const check = checks[instance.id]!, [first, second] = check.adjudication;
      if (Object.entries(check.teachers).some(([id, vote]) => id !== adjudicator.id && vote.answer !== null && vote.answer === first!.answer && (vote.p ?? 1) > 0) && first!.answer !== null && Object.hasOwn(instance.criteria, first!.answer) && first!.answer === second!.answer && (first!.p ?? 1) > 0 && (second!.p ?? 1) > 0) {
        check.final = first!.answer; check.status = 'adjudicated';
      }
    }
  }
  return checkpoint(true);
}
