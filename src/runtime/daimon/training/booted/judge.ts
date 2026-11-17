import { createHash, randomUUID } from 'node:crypto';
import type { InferenceFailureKind, InferenceProvider } from '../../../../training/index.js';
import { InferenceFailure, validateInferenceResponse, validateInferenceSchema } from '../../../../training/index.js';
import { bootedUsage, type BootedWake } from './adapter.js';

/** One judge identity: the engine, and the model and effort its compiled organization pins. */
export interface BootedJudgeSpec { engine: string; model: string; effort?: string }

/** The run's warm judges: one booted container per judge identity, woken once per judgment. */
export interface BootedJudgeLauncher {
  judge(spec: BootedJudgeSpec): Promise<{ wake(text: string, options: { deliveryId: string; timeoutMs: number; signal?: AbortSignal }): Promise<BootedWake> }>;
}

let bound: BootedJudgeLauncher | undefined;

/**
 * Valid judgments kept across runs. `take` hands out the n-th recorded reply for the n-th identical request of this
 * process, so a judgment asked twice on purpose (questionnaire repeats) stays two samples; `put` records a fresh one
 * at the occurrence `take` returned.
 */
export interface BootedJudgmentCache {
  take(key: string): Promise<{ occurrence: number; reply?: string }>;
  put(key: string, occurrence: number, reply: string): Promise<void>;
}
let judgments: BootedJudgmentCache | undefined;
let proposals = false;

/**
 * Binds the run's judgment cache (or none) for the run's duration, beside its judge launcher. With `proposals`, an
 * optimizer's identical request also replays its recorded proposal, so an unchanged rerun repeats the whole search.
 */
export function bindBootedJudgmentCache(cache: BootedJudgmentCache | undefined, options: { proposals?: boolean } = {}): void {
  judgments = cache;
  proposals = options.proposals === true;
}

/** The judge identity and the whole wake text: the article, every question of the bank, the schema and the model. */
export function judgmentKey(engine: string, model: string, effort: string | undefined, text: string, purpose: 'judge' | 'optimizer' = 'judge'): string {
  return createHash('sha256').update(JSON.stringify([engine, model, effort ?? null, text, ...(purpose === 'judge' ? [] : [purpose])])).digest('hex');
}

/**
 * Composition binds the training run's judge launcher for the run's duration
 * (`spawnfile train` runs one run per process). Providers resolve it per
 * judgment, so grader and model registries stay static data.
 */
export function bindBootedJudges(launcher: BootedJudgeLauncher | undefined, report?: (line: string) => void): void { bound = launcher; reportFailure = report; }

/**
 * The operator's own channel (the run's stderr) for why a judge could not answer. A judgment requested through the
 * optimizer bridge comes back as a failure kind alone, so without this line a judge that never booted (its gateway
 * exited, its login was held) read only as "unavailable".
 */
let reportFailure: ((line: string) => void) | undefined;

export interface BootedJudgeOptions {
  engine: string; effort?: string; timeoutMs?: number;
  /** What the route asks for: judgments are cached; an optimizer's proposals only when the run binds `proposals`. */
  purpose?: 'judge' | 'optimizer';
}

/**
 * Structured records of a wake transcript that are not a message or
 * reasoning: any other item kind is tool activity, including future native
 * tool families. Engine-neutral: it reads record and item kinds only.
 */
const TEXT_KINDS = /^(message|reasoning|agent_message|agent_reasoning|user_message|text|thinking)$/u;
const TOOL_KINDS = /tool|function|shell|exec|command|mcp|web_search|patch|file_change|search_tool|use_tool|call/iu;

export function transcriptToolActivity(transcript: string): string[] {
  const found = new Set<string>();
  for (const line of transcript.split('\n')) {
    if (!line.trim()) continue;
    let record: unknown;
    try { record = JSON.parse(line); } catch { found.add('unparseable-record'); continue; }
    if (record === null || typeof record !== 'object') continue;
    const visit = (value: unknown, depth: number): void => {
      if (depth > 3 || value === null || typeof value !== 'object' || Array.isArray(value)) return;
      const entry = value as Record<string, unknown>;
      const kind = entry['type'];
      if (typeof kind === 'string' && !TEXT_KINDS.test(kind) && TOOL_KINDS.test(kind)) found.add(kind);
      for (const key of ['payload', 'item', 'message', 'content']) {
        const nested = entry[key];
        if (Array.isArray(nested)) nested.forEach(child => visit(child, depth + 1)); else visit(nested, depth + 1);
      }
    };
    visit(record, 0);
  }
  return [...found].sort();
}

/**
 * Daimon's wake receipt carries at most this many bytes of reply text (its organization runtime contract), cut
 * silently. A judgment is not bound by it: an optimizer proposal holds a whole prompt file.
 */
export const RECEIPT_TEXT_BYTES = 16_384;

/**
 * The judge's whole reply. Below the receipt cap the receipt text is the reply. At the cap it may be cut, so the
 * reply is the transcript's last assistant message that the receipt text begins: the same answer, whole. Without one,
 * the receipt text stands and is validated as it is. Engine-neutral: it reads role, content and message fields only.
 */
export function wholeReply(text: string, transcript: string | null): string {
  if (Buffer.byteLength(text, 'utf8') < RECEIPT_TEXT_BYTES || transcript === null) return text;
  const prefix = text.trim();
  let found: string | undefined;
  const visit = (value: unknown, depth: number): void => {
    if (depth > 3 || value === null || typeof value !== 'object' || Array.isArray(value)) return;
    const entry = value as Record<string, unknown>;
    const content = entry['content'];
    const candidate = entry['role'] === 'assistant' && Array.isArray(content)
      ? content.map(part => (part !== null && typeof part === 'object' && typeof (part as Record<string, unknown>)['text'] === 'string' ? (part as Record<string, string>)['text'] : '')).join('')
      : entry['type'] === 'agent_message' && typeof entry['message'] === 'string' ? entry['message'] : undefined;
    if (candidate !== undefined && candidate.trim().length > prefix.length && candidate.trim().startsWith(prefix)) found = candidate;
    for (const key of ['payload', 'item', 'msg']) visit(entry[key], depth + 1);
  };
  for (const line of transcript.split('\n')) {
    if (!line.trim()) continue;
    try { visit(JSON.parse(line), 0); } catch { /* an unreadable record holds no reply */ }
  }
  return found ?? text;
}

/** The runtime's own failure for a judge wake that did not complete, as one bounded line. */
function wakeReason(wake: BootedWake): string {
  const line = (wake.failure ?? '').replace(/\s+/gu, ' ').trim();
  return line ? `: ${line.slice(0, 400)}` : '';
}

function wakeFailure(wake: BootedWake): InferenceFailureKind {
  if (wake.state === 'timeout') return 'timeout';
  if (wake.state === 'stopped') return 'cancelled';
  const evidence = `${wake.code ?? ''} ${wake.text}`;
  if (/auth_stale|unauthorized|authentication|sign in|login|401|403/iu.test(evidence)) return 'authentication';
  if (/quota|usage limit|rate limit|429|402/iu.test(evidence)) return 'quota';
  return 'unavailable';
}

/**
 * The one subscription inference path of a training run: each judgment is
 * one wake of the run's warm, tool-free judge organization for this engine,
 * whose login lives only in the run's auth gateway (or the engine's own
 * realm). The reply is validated against the requested schema after the
 * wake. A wake whose transcript or per-request tool record shows any tool
 * activity is refused, and so is one that left no evidence either way.
 */
export function createBootedJudgeInference(options: BootedJudgeOptions): InferenceProvider {
  const route = `${options.engine}-subscription`;
  return {
    id: route,
    capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
    async generate(request) {
      validateInferenceSchema(request.responseSchema);
      if (!request.prompt.trim() || !request.model.trim() || request.temperature !== undefined || request.seed !== undefined) {
        throw new InferenceFailure('unsupported', `Invalid ${route} inference controls`);
      }
      if (request.signal?.aborted) throw new InferenceFailure('cancelled', `${route} cancelled before the wake`);
      if (!bound) throw new InferenceFailure('unavailable', 'Subscription judges run only as booted containers inside `spawnfile train --auth-profile <name>`');
      const evidence = { responseModel: null, responseRoute: route };
      const schemaText = request.responseSchema === undefined ? '' : [
        '', '', 'Reply with exactly one JSON value that validates against this JSON Schema and nothing else:',
        JSON.stringify(request.responseSchema),
      ].join('\n');
      const text = `${request.system === undefined ? '' : `${request.system}\n\n`}${request.prompt}${schemaText}`;
      const purpose = options.purpose ?? 'optimizer';
      const cache = purpose === 'judge' || proposals ? judgments : undefined;
      const key = judgmentKey(options.engine, request.model, options.effort, text, purpose);
      const slot = cache ? await cache.take(key).catch(() => undefined) : undefined;
      // A cached judgment spent nothing now: no usage is reported for it.
      if (slot?.reply !== undefined) return { text: slot.reply, model: request.model, modelBasis: 'requested-assumption', usage: null, route };
      const judge = await bound.judge({ engine: options.engine, model: request.model, ...(options.effort === undefined ? {} : { effort: options.effort }) })
        .catch((error: unknown) => {
          const message = `${route} judge did not boot: ${error instanceof Error ? error.message : String(error)}`;
          reportFailure?.(message);
          throw new InferenceFailure('unavailable', message, evidence);
        });
      // A wake that throws (not accepted, the container unreachable) is a failure with a reason like any other: left
      // unclassified it reached the operator as "Routed inference stopped (unknown)" and nothing else.
      const wake = await judge.wake(text, { deliveryId: `judge-${randomUUID()}`, timeoutMs: options.timeoutMs ?? 180_000, signal: request.signal })
        .catch((error: unknown) => {
          if (request.signal?.aborted) throw new InferenceFailure('cancelled', `${route} judgment cancelled`, evidence);
          const message = `${route} judge wake failed: ${(error instanceof Error ? error.message : String(error)).replace(/\s+/gu, ' ').trim().slice(0, 400)}`;
          reportFailure?.(message);
          throw new InferenceFailure('unavailable', message, evidence);
        });
      const usage = bootedUsage(wake.usage);
      const withUsage = { ...evidence, usage };
      if (request.signal?.aborted) throw new InferenceFailure('cancelled', `${route} judgment cancelled`, withUsage);
      if (wake.state !== 'completed') {
        const message = `${route} judge wake ${wake.state}${wake.code ? ` (${wake.code})` : ''}${wakeReason(wake)}`;
        reportFailure?.(message);
        throw new InferenceFailure(wakeFailure(wake), message, withUsage);
      }
      const requests = wake.requestToolCalls ?? [];
      if ((wake.transcript !== null && transcriptToolActivity(wake.transcript).length > 0) || requests.some(calls => calls !== null && calls.length > 0)) {
        throw new InferenceFailure('protocol', `${route} attempt refused: tool-call`, { ...withUsage, detail: 'tool-call' });
      }
      // Proof of a tool-free wake: the engine transcript, or every model request's own tool-call record.
      if (wake.transcript === null && (requests.length === 0 || requests.some(calls => calls === null))) {
        throw new InferenceFailure('protocol', `${route} judge left no evidence to prove a tool-free judgment`, withUsage);
      }
      const reply = wholeReply(wake.text, wake.transcript).trim();
      if (!reply) throw new InferenceFailure('protocol', `${route} judge replied with nothing`, withUsage);
      try {
        validateInferenceResponse(reply, request.responseSchema, request.responseJsonFence);
      } catch {
        throw new InferenceFailure('invalid-response', `${route} answer violated the requested schema`, withUsage);
      }
      if (cache && slot) await cache.put(key, slot.occurrence, reply).catch(() => undefined);
      return { text: reply, model: request.model, modelBasis: 'requested-assumption', usage, route };
    },
  };
}
