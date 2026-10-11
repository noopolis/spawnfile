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
  const window = options.grokWindow ?? defaultGrokWindow;
  const adjudicatorId = options.adjudicator ?? teachers[0]!.id;
  // Historical completed references remain reusable across the current clock window.
  const identity = stableDigest({ version: councilPromptVersion, output: options.outputDigest,
    instances, teachers, adjudicator: adjudicatorId, window,
    seed: options.seed ?? 'paideia.council', timeoutMs: options.timeoutMs ?? 120_000 });
  if (options.previous) {
    if (!reusableCouncil(options.previous, identity)) throw new Error('Stale or corrupt council checkpoint');
    return options.previous;
  }
  const now = options.now ?? new Date();
  const skipped = teachers.filter(t => t.provider === 'grok' && !grokWindowOpen(now, window))
    .map(t => ({ teacher: t.id, reason: `Outside Grok window ${window.start}-${window.end} ${window.timeZone ?? 'Europe/Berlin'}` }));
  const active = teachers.filter(t => !skipped.some(s => s.teacher === t.id));
  const adjudicator = active.find(t => t.id === adjudicatorId);
  if (!adjudicator) throw new Error('Adjudicator is not an active teacher');
  for (const teacher of active) {
    const provider = providers[teacher.id];
    if (!provider || provider.capabilities.billing !== 'subscription' || !['disabled', 'contained'].includes(provider.capabilities.tools)) {
      throw new Error(`Council teacher ${teacher.id} requires tool-isolated subscription inference`);
    }
  }
  const calls: ReferenceCall[] = [];
  const checks: CouncilOutput['checks'] = Object.fromEntries(instances.map(instance => [instance.id, {
    digest: instance.digest, template_id: instance.template_id, teachers: {},
    distribution: {}, unknown_mass: 1, adjudication: [], final: null, status: 'uncertain',
  }]));
  const invoke = async (teacher: CouncilTeacher, batch: CheckInstance[], competing?: Record<string, TeacherAnswer[]>, run?: number) => {
    options.signal?.throwIfAborted();
    if (teacher.provider === 'grok' && !grokWindowOpen(options.now ?? new Date(), window)) {
      if (!skipped.some(item => item.teacher === teacher.id)) skipped.push({ teacher: teacher.id,
        reason: `Grok window closed before ${competing ? 'adjudication' : 'teacher'} call` });
      return null;
    }
    const prompt = councilPrompt(batch, competing), start = performance.now();
    const call: ReferenceCall = { id: stableDigest([identity, teacher.id, prompt.digest, calls.length]),
      teacher: teacher.id, provider: teacher.provider, requestedModel: teacher.model, reportedModel: null, route: null,
      prompt_digest: prompt.digest, phase: competing ? 'adjudication' : 'teacher', ...(run === undefined ? {} : { run }),
      check_ids: batch.map(i => i.id), at: new Date().toISOString(), wallMs: 0, usage: null, outcome: 'generation-error' };
    let answers: Record<string, TeacherAnswer> | null = null;
    try {
      const response = await providers[teacher.id]!.generate({ model: teacher.model, system: prompt.system,
        prompt: prompt.prompt, responseSchema: prompt.schema, signal: AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 120_000), ...(options.signal ? [options.signal] : [])]) });
      call.reportedModel = response.modelBasis === 'requested-assumption' ? null : response.model;
      call.route = response.route; call.usage = response.usage;
      if (response.attempts) call.attempts = response.attempts;
      answers = decodeCouncilAnswers(response.text, batch, competing !== undefined);
      call.outcome = answers ? 'completed' : 'invalid-response';
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error !== null && typeof error === 'object') {
        const failure = error as Partial<ReferenceCall> & { responseModel?: string; responseRoute?: string };
        call.usage = failure.usage ?? null;
        call.reportedModel = failure.responseModel ?? null; call.route = failure.responseRoute ?? null;
        if (failure.attempts) call.attempts = failure.attempts;
      }
    }
    call.wallMs = performance.now() - start; calls.push(call);
    return answers;
  };
  const batches = new Map<string, CheckInstance[]>();
  for (const instance of instances.filter(i => i.status === 'ready')) {
    const key = stableDigest(instance.projection), batch = batches.get(key) ?? [];
    batch.push(instance); batches.set(key, batch);
  }
  // All independent responses are collected before exposing any peer evidence.
  for (const teacher of active) {
    for (const batch of batches.values()) {
      const answers = await invoke(teacher, batch);
      for (const instance of batch) checks[instance.id]!.teachers[teacher.id] = answers?.[instance.id] ?? { answer: 'missing' };
    }
  }
  const disputed: CheckInstance[] = [];
  for (const instance of instances) {
    const check = checks[instance.id]!;
    for (const teacher of active) check.teachers[teacher.id] ??= { answer: 'missing' };
    const answers = Object.values(check.teachers);
    Object.assign(check, averageAnswers(instance.options, answers));
    if (instance.status !== 'ready') continue;
    if (answers.every(a => a.answer === answers[0]!.answer && Object.hasOwn(instance.criteria, a.answer) && (a.p ?? 1) > 0)) {
      check.final = answers[0]!.answer; check.status = 'agreed';
    } else disputed.push(instance);
  }
  if (disputed.length) {
    // Stable seeded shuffling and a fresh reverse-order run reveal order sensitivity.
    const competing = Object.fromEntries(disputed.map(instance => [instance.id,
      active.map(teacher => ({ key: stableDigest([options.seed ?? 'paideia.council', instance.id, teacher.id]),
        vote: checks[instance.id]!.teachers[teacher.id]! })).sort((a, b) => a.key.localeCompare(b.key)).map(item => item.vote)]));
    for (const run of [0, 1]) {
      const ordered = run === 0 ? competing : Object.fromEntries(Object.entries(competing).map(([id, votes]) => [id, [...votes].reverse()]));
      const answers = await invoke(adjudicator, disputed, ordered, run);
      for (const instance of disputed) checks[instance.id]!.adjudication.push(answers?.[instance.id] ?? { answer: 'uncertain' });
    }
    for (const instance of disputed) {
      const check = checks[instance.id]!, [first, second] = check.adjudication;
      if (first!.answer !== 'uncertain' && first!.answer === second!.answer && (first!.p ?? 1) > 0 && (second!.p ?? 1) > 0) {
        check.final = first!.answer; check.status = 'adjudicated';
      }
    }
  }
  const content: Omit<CouncilOutput, 'digest'> = { outputDigest: options.outputDigest, identity, complete: true, checks, calls, skipped };
  const output = { ...content, digest: councilContentDigest(content) };
  await options.onCheckpoint?.(output);
  return output;
}
