import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { JudgeCall, JudgeRoute } from '../contracts/evaluation.js';
import { combineAnswers, judgeAnswer, scoreQuestionnaire } from './answers.js';
import { groupSchema, questionnaireSystem, renderGroupPrompt, type QuestionnaireMaterial } from './prompt.js';
import type { AnswerRecord, QuestionBank, QuestionnaireScore, ScoredAnswer } from './types.js';

/** The route fields a questionnaire uses; `effort` is what the route was built with, when it declares one. */
export type QuestionnaireJudge = Pick<JudgeRoute, 'provider' | 'model' | 'effort'>;

export interface QuestionnaireResult extends QuestionnaireScore {
  bank: { id: string; version?: number | string };
  answers: ScoredAnswer[];
  /** Working steps by group: evaluator evidence, never optimizer feedback. */
  scaffold: Record<string, Record<string, unknown>>;
  /** Groups whose judge could not be asked or did not answer, with the reason. */
  failedCalls: { group: string; repeat: number; reason: string }[];
  judgeCalls: JudgeCall[];
}

export interface RunQuestionnaireOptions {
  bank: QuestionBank;
  material: QuestionnaireMaterial;
  judges: Readonly<Record<string, QuestionnaireJudge>>;
  signal?: AbortSignal;
  /** Awaited after every attempt, before its answers are accepted. */
  observe?: (attempt: { call: JudgeCall; response: string }) => void | Promise<void>;
  /** Wait before asking a group again after a transient failure; defaults to {@link GROUP_RETRY_DELAY_MS}. */
  retryDelayMs?: number;
}

/** Attempts per group and repeat: a transient judge failure is asked again, never answered for the judge. */
export const GROUP_ATTEMPTS = 3;
export const GROUP_RETRY_DELAY_MS = 5_000;
const transientKinds: ReadonlySet<string> = new Set(['transport', 'unavailable', 'timeout', 'quota', 'invalid-response']);

interface Attempt { call: JudgeCall; reply?: Record<string, unknown>; reason?: string; transient: boolean }

async function askGroup(route: QuestionnaireJudge, judge: string, prompt: string, schema: ReturnType<typeof groupSchema>,
  options: RunQuestionnaireOptions): Promise<Attempt> {
  options.signal?.throwIfAborted();
  const call: JudgeCall = { id: randomUUID(), judge, providerId: route.provider.id, requestedModel: route.model,
    responseModel: null, responseRoute: null, outcome: 'generation-error', usage: null };
  const started = performance.now();
  let text = '';
  let attempt: Attempt;
  try {
    const response = await route.provider.generate({ model: route.model, system: questionnaireSystem, prompt, responseSchema: schema, signal: options.signal });
    text = response.text;
    Object.assign(call, { responseModel: response.modelBasis === 'requested-assumption' ? null : response.model,
      responseRoute: response.route, usage: response.usage, outcome: 'invalid-response' });
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('reply is not a JSON object');
    call.outcome = 'completed';
    attempt = { call, reply: parsed as Record<string, unknown>, transient: false };
  } catch (error) {
    options.signal?.throwIfAborted();
    const failure = error as { kind?: unknown; usage?: JudgeCall['usage']; responseRoute?: string | null };
    if (call.outcome === 'generation-error') {
      if (typeof failure?.kind === 'string') call.failureKind = failure.kind as JudgeCall['failureKind'];
      call.usage = failure?.usage ?? null;
      call.responseRoute = failure?.responseRoute ?? null;
    }
    const generation = call.outcome === 'generation-error';
    attempt = { call, reason: generation ? `judge call failed${call.failureKind ? ` (${call.failureKind})` : ''}` : 'judge reply was not a JSON object',
      transient: !generation || transientKinds.has(call.failureKind ?? 'unknown') };
  }
  call.wallMs = performance.now() - started;
  call.billing = route.provider.capabilities.billing;
  await options.observe?.({ call: structuredClone(call), response: text });
  return attempt;
}

/**
 * Asks every group in declared order: one judge call per group per repeat, each on the group's named
 * route, with the earlier groups' requested working handed on. A transient failure (provider down, timed
 * out, rate-limited, or a reply that is not a JSON object) asks the whole group again, up to
 * {@link GROUP_ATTEMPTS} calls; every call is recorded. A group that still has no reply leaves every answer
 * an error; nothing is ever defaulted to a pass.
 */
export async function runQuestionnaire(options: RunQuestionnaireOptions): Promise<QuestionnaireResult> {
  const { bank, material } = options;
  const records: Record<string, AnswerRecord> = {};
  const answers: ScoredAnswer[] = [];
  const scaffold: QuestionnaireResult['scaffold'] = {};
  const failedCalls: QuestionnaireResult['failedCalls'] = [];
  const judgeCalls: JudgeCall[] = [];
  for (const group of bank.groups) {
    const received: Record<string, unknown> = {};
    for (const name of group.receives) {
      const [from, step] = name.split('.') as [string, string];
      const value = scaffold[from]?.[step];
      if (typeof value === 'string' || Array.isArray(value)) received[name] = value;
    }
    const route = Object.hasOwn(options.judges, group.judge) ? options.judges[group.judge] : undefined;
    const refusal = !route ? `judge route ${group.judge} is not configured`
      : group.effort !== undefined && route.effort !== group.effort ? `judge route ${group.judge} runs effort ${route.effort ?? 'unset'}, the bank requires ${group.effort}` : undefined;
    const prompt = renderGroupPrompt(bank, group, material, received);
    const schema = groupSchema(group);
    const repeats: Record<string, AnswerRecord>[] = [];
    for (let repeat = 1; repeat <= group.repeats; repeat++) {
      let reply: Record<string, unknown> = {};
      if (refusal) failedCalls.push({ group: group.id, repeat, reason: refusal });
      else {
        for (let tries = 1; ; tries++) {
          const attempt = await askGroup(route!, group.judge, prompt, schema, options);
          judgeCalls.push(attempt.call);
          if (attempt.reply) { reply = attempt.reply; break; }
          if (!attempt.transient || tries >= GROUP_ATTEMPTS) { failedCalls.push({ group: group.id, repeat, reason: attempt.reason! }); break; }
          await delay(options.retryDelayMs ?? GROUP_RETRY_DELAY_MS, options.signal);
        }
      }
      repeats.push(Object.fromEntries(group.questions.map(question => {
        const entry = Object.hasOwn(reply, question.id) ? reply[question.id] : undefined;
        const fields = entry !== null && typeof entry === 'object' ? entry as { answer?: unknown; reason?: unknown } : {};
        return [question.id, judgeAnswer(question, fields.answer, fields.reason)];
      })));
    }
    scaffold[group.id] = {};
    for (const question of group.questions) {
      const votes = repeats.map(repeat => repeat[question.id]!);
      if (question.role === 'scaffold') scaffold[group.id]![question.id] = votes[0]!.status === 'ok' ? votes[0]!.answer : { error: votes[0]!.error };
      else {
        const record = combineAnswers(question, votes, group.combine);
        records[question.id] = record;
        answers.push({ ...record, group: group.id, ask: question.ask, hidden: question.hidden, gate: question.gate, weight: question.weight });
      }
    }
  }
  return { bank: { id: bank.id, ...(bank.version === undefined ? {} : { version: bank.version }) },
    ...scoreQuestionnaire(bank, records), answers, scaffold, failedCalls, judgeCalls };
}
