import { randomUUID } from 'node:crypto';
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
 * Composition binds the training run's judge launcher for the run's duration
 * (`spawnfile train` runs one run per process). Providers resolve it per
 * judgment, so grader and model registries stay static data.
 */
export function bindBootedJudges(launcher: BootedJudgeLauncher | undefined): void { bound = launcher; }

export interface BootedJudgeOptions { engine: string; effort?: string; timeoutMs?: number }

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
      const judge = await bound.judge({ engine: options.engine, model: request.model, ...(options.effort === undefined ? {} : { effort: options.effort }) })
        .catch((error: unknown) => { throw new InferenceFailure('unavailable', `${route} judge did not boot: ${error instanceof Error ? error.message : String(error)}`, evidence); });
      const schema = request.responseSchema === undefined ? '' : [
        '', '', 'Reply with exactly one JSON value that validates against this JSON Schema and nothing else:',
        JSON.stringify(request.responseSchema),
      ].join('\n');
      const text = `${request.system === undefined ? '' : `${request.system}\n\n`}${request.prompt}${schema}`;
      const wake = await judge.wake(text, { deliveryId: `judge-${randomUUID()}`, timeoutMs: options.timeoutMs ?? 180_000, signal: request.signal });
      const usage = bootedUsage(wake.usage);
      const withUsage = { ...evidence, usage };
      if (request.signal?.aborted) throw new InferenceFailure('cancelled', `${route} judgment cancelled`, withUsage);
      if (wake.state !== 'completed') throw new InferenceFailure(wakeFailure(wake), `${route} judge wake ${wake.state}${wake.code ? ` (${wake.code})` : ''}`, withUsage);
      const requests = wake.requestToolCalls ?? [];
      if ((wake.transcript !== null && transcriptToolActivity(wake.transcript).length > 0) || requests.some(calls => calls !== null && calls.length > 0)) {
        throw new InferenceFailure('protocol', `${route} attempt refused: tool-call`, { ...withUsage, detail: 'tool-call' });
      }
      // Proof of a tool-free wake: the engine transcript, or every model request's own tool-call record.
      if (wake.transcript === null && (requests.length === 0 || requests.some(calls => calls === null))) {
        throw new InferenceFailure('protocol', `${route} judge left no evidence to prove a tool-free judgment`, withUsage);
      }
      const reply = wake.text.trim();
      if (!reply) throw new InferenceFailure('protocol', `${route} judge replied with nothing`, withUsage);
      try {
        validateInferenceResponse(reply, request.responseSchema, request.responseJsonFence);
      } catch {
        throw new InferenceFailure('invalid-response', `${route} answer violated the requested schema`, withUsage);
      }
      return { text: reply, model: request.model, modelBasis: 'requested-assumption', usage, route };
    },
  };
}
