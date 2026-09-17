import { randomUUID } from 'node:crypto';
import type { InferenceAttempt, InferenceProvider, InferenceRequest, InferenceResult } from '../contracts/execution.js';
import { immutableAttempts, InferenceFailure } from './failure.js';

export interface InferenceRoute { provider: InferenceProvider; model: string }
export interface RoutedInferenceOptions {
  id: string;
  routes: readonly InferenceRoute[];
  maxAttempts: number;
  /** Deadline shared by all attempts and their audit writes. */
  timeoutMs: number;
  /** Optional additional cap on each attempt's share of remaining time. */
  attemptTimeoutMs?: number;
  /** Trusted durable sink; failure stops the route before another generation. */
  observeAttempt?: (attempt: Readonly<InferenceAttempt>) => void | Promise<void>;
}

export function createRoutedInference(options: RoutedInferenceOptions): InferenceProvider {
  if (!options.id.trim() || !options.routes.length || !Number.isSafeInteger(options.maxAttempts) ||
    options.maxAttempts < 1 || options.maxAttempts > options.routes.length) throw new Error('Invalid inference route budget');
  for (const ms of [options.timeoutMs, options.attemptTimeoutMs ?? options.timeoutMs]) {
    if (!Number.isSafeInteger(ms) || ms < 1 || ms > 2_147_483_647) throw new Error('Invalid inference time budget');
  }
  const routes = options.routes.map(({ provider, model }) => {
    if (!provider.id.trim() || !model.trim() || model.startsWith('-') ||
      provider.capabilities.tools !== 'disabled') throw new Error('Explicit tool-free routes are required');
    return Object.freeze({ provider, model });
  });
  const { maxAttempts, timeoutMs, attemptTimeoutMs = timeoutMs, observeAttempt } = options;
  return {
    id: options.id,
    capabilities: { tools: 'disabled', billing: routes.every(route => route.provider.capabilities.billing === routes[0]!.provider.capabilities.billing) ? routes[0]!.provider.capabilities.billing : 'mixed', temperature: false, seed: false },
    async generate(request) {
      if (request.temperature !== undefined || request.seed !== undefined) throw new InferenceFailure('unsupported', 'Routed inference does not support sampling controls');
      if (!request.prompt.trim()) throw new InferenceFailure('unsupported', 'Inference prompt must not be empty');
      const attempts: InferenceAttempt[] = [];
      const deadline = Date.now() + timeoutMs;
      // A stale shared credential authority fails fast: later routes on it are never attempted.
      const stale = new Set<string>();
      let index = 0;
      for (let ordinal = 0; ordinal < maxAttempts; ordinal++) {
        if (request.signal?.aborted) throw new InferenceFailure('cancelled', 'Routed inference cancelled', { attempts });
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new InferenceFailure('timeout', 'Routed inference time budget exhausted', { attempts });
        const route = routes[index++]!;
        const startedAt = new Date().toISOString();
        let result: InferenceResult | undefined;
        let failure: InferenceFailure | undefined;
        // Reserve time for each remaining authored route; unused time carries forward.
        const share = Math.max(1, Math.floor(remaining / (maxAttempts - ordinal)));
        try { result = await generateBounded(route, request, Math.min(remaining, share, attemptTimeoutMs)); }
        catch (error) {
          failure = error instanceof InferenceFailure ? error : new InferenceFailure('unknown', 'Inference provider failed without a classified refusal');
        }
        const attempt = immutableAttempts([{ id: randomUUID(), ordinal: ordinal + 1,
          providerId: route.provider.id, requestedModel: route.model,
          responseModel: result === undefined ? failure!.responseModel : result.modelBasis === 'requested-assumption' ? null : result.model,
          responseRoute: result?.route ?? failure?.responseRoute ?? null,
          outcome: result === undefined ? 'failed' : 'completed', failureKind: failure?.kind ?? null,
          startedAt, completedAt: new Date().toISOString(), usage: result?.usage ?? failure?.usage ?? null,
        }])[0]!;
        attempts.push(attempt);
        try {
          if (observeAttempt || (failure?.diagnostic && request.observeFailure)) await persistBounded(async () => {
            await observeAttempt?.(attempt);
            if (failure?.diagnostic) await request.observeFailure?.({ attempt, ...(ordinal ? { fallbackOf: attempts[0]!.id } : {}), diagnostic: failure.diagnostic });
          }, deadline - Date.now(), request.signal);
        }
        catch (error) {
          const kind = request.signal?.aborted ? 'cancelled' : error instanceof AuditBoundaryFailure ? error.kind : Date.now() >= deadline ? 'timeout' : 'unknown';
          throw new InferenceFailure(kind, 'Inference audit persistence failed', { attempts });
        }
        if (result !== undefined) return { ...result, attempts: immutableAttempts(attempts) };
        if (failure!.kind === 'auth-stale') stale.add(authority(route));
        while (index < routes.length && stale.has(authority(routes[index]!))) index++;
        if (!['quota', 'transport', 'unavailable', 'timeout', 'invalid-response', 'auth-stale'].includes(failure!.kind) ||
          ordinal + 1 === maxAttempts || index === routes.length) {
          throw new InferenceFailure(failure!.kind, `Routed inference stopped (${failure!.kind})`, { attempts });
        }
      }
      throw new Error('Unreachable inference route state');
    },
  };
}

const authority = (route: InferenceRoute): string => route.provider.capabilities.credentialAuthority ?? `provider:${route.provider.id}`;

async function generateBounded(route: InferenceRoute, request: InferenceRequest, timeoutMs: number): Promise<InferenceResult> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interrupt!: () => void;
  const boundary = new Promise<never>((_resolve, reject) => {
    interrupt = () => { controller.abort(); reject(new InferenceFailure('cancelled', 'Inference cancelled')); };
    request.signal?.addEventListener('abort', interrupt, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new InferenceFailure('timeout', 'Inference attempt time budget exhausted'));
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([route.provider.generate({ ...request, model: route.model, signal: controller.signal }), boundary]);
    if (timedOut) throw new InferenceFailure('timeout', 'Inference attempt time budget exhausted', {
      usage: result.usage, responseModel: result.modelBasis === 'requested-assumption' ? null : result.model, responseRoute: result.route,
    });
    return result;
  } catch (error) {
    // Abort-responsive providers may settle with known counters immediately. Keep
    // that receipt while attributing cancellation to our timer, not the operator.
    if (timedOut && (!(error instanceof InferenceFailure) || ['cancelled', 'timeout'].includes(error.kind))) {
      throw new InferenceFailure('timeout', 'Inference attempt time budget exhausted', error instanceof InferenceFailure ? error : {});
    }
    throw error;
  } finally { clearTimeout(timer); request.signal?.removeEventListener('abort', interrupt); }
}

class AuditBoundaryFailure extends Error {
  constructor(readonly kind: 'cancelled' | 'timeout') { super(`Audit boundary ${kind}`); }
}

/** An unavailable audit store must not leave an unattended route running forever. */
async function persistBounded(write: () => void | Promise<void>, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new AuditBoundaryFailure('cancelled');
  if (timeoutMs <= 0) throw new AuditBoundaryFailure('timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interrupt!: () => void;
  const boundary = new Promise<never>((_resolve, reject) => {
    interrupt = () => reject(new AuditBoundaryFailure('cancelled'));
    signal?.addEventListener('abort', interrupt, { once: true });
    timer = setTimeout(() => reject(new AuditBoundaryFailure('timeout')), timeoutMs);
  });
  try { await Promise.race([Promise.resolve().then(write), boundary]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', interrupt); }
}
