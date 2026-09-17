import { GrokGrantRefusal, type GrokGrantModel, type GrokGrantPurpose, type GrokGrantReasoningEffort,
  type GrokInferenceGrant, type GrokInferenceGrantAuthority } from '../../contracts/inference-grants.js';
import { InferenceFailure } from '../failure.js';

export interface GrokGrantKey { model: GrokGrantModel; reasoningEffort: GrokGrantReasoningEffort; purpose: GrokGrantPurpose }

export interface GrokGrantPoolOptions {
  /** Stable identity of the shared credential authority (e.g. the control socket); routes on it fail fast together. */
  id: string;
  /** Resolved once. A rejection means broker-grant is unavailable here and fails closed. */
  authority: () => Promise<GrokInferenceGrantAuthority>;
  /** Concurrent lanes (grants) per model/effort/purpose; matches the default judge check concurrency. */
  lanesPerRoute?: number;
  /** A lane idle this long releases its grant so other evaluators can use the broker's live-grant slot. */
  idleReleaseMs?: number;
  /** A grant is renewed when less than this margin plus the call budget remains before expiry. */
  renewMarginMs?: number;
  /** Tokens a single request may still spend (broker per-request usage bound); a lane renews before the grant ceiling. */
  requestTokenReserve?: number;
  /** Queue backoff while the broker's live-grant cap is reached. */
  capBackoffMs?: readonly [initial: number, maximum: number];
  releaseTimeoutMs?: number;
  now?: () => number;
}

export type GrokGrantOutcome = Readonly<{ ok: true; tokens: number | null }> | Readonly<{ ok: false }>;
export interface GrokGrantLease {
  readonly authority: GrokInferenceGrantAuthority;
  readonly grant: GrokInferenceGrant;
  /** Time the CLI call may take without outliving the grant. */
  readonly callTimeoutMs: number;
  /** Exactly once: success keeps the grant for this lane's next call; failure releases it. */
  settle(outcome: GrokGrantOutcome): Promise<void>;
}

interface Lane { key: string; spec: GrokGrantKey; grant?: GrokInferenceGrant; requests: number; tokens: number; busy: boolean; idle?: ReturnType<typeof setTimeout> }

/**
 * One grant per concurrent lane, reused sequentially until it nears expiry or
 * its request/token ceilings, then renewed. Never holds more grants than the
 * broker's live-grant cap; when the broker refuses `grant_limit` (other
 * evaluators hold the slots) the lane queues with backoff until the caller's
 * signal ends the wait. Grants are released on any failure, when idle, and on close.
 */
export class GrokGrantPool {
  readonly id: string;
  private readonly lanes: Lane[] = [];
  private waiters: (() => void)[] = [];
  private resolved?: Promise<GrokInferenceGrantAuthority>;
  private closed = false;
  private readonly lanesPerRoute: number;
  private readonly idleReleaseMs: number;
  private readonly renewMarginMs: number;
  private readonly reserve: number;
  private readonly backoff: readonly [number, number];
  private readonly releaseTimeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly options: GrokGrantPoolOptions) {
    this.id = options.id;
    this.lanesPerRoute = options.lanesPerRoute ?? 2;
    this.idleReleaseMs = options.idleReleaseMs ?? 30_000;
    this.renewMarginMs = options.renewMarginMs ?? 5_000;
    this.reserve = options.requestTokenReserve ?? 500_000;
    this.backoff = options.capBackoffMs ?? [250, 2_000];
    this.releaseTimeoutMs = options.releaseTimeoutMs ?? 2_000;
    this.now = options.now ?? Date.now;
    if (!options.id.trim() || !Number.isSafeInteger(this.lanesPerRoute) || this.lanesPerRoute < 1 || this.lanesPerRoute > 8) throw new Error('Invalid Grok grant pool policy');
  }

  async acquire(spec: GrokGrantKey, needMs: number, signal?: AbortSignal): Promise<GrokGrantLease> {
    const authority = await this.authority();
    const key = `${spec.model}\0${spec.reasoningEffort}\0${spec.purpose}`;
    for (;;) {
      if (signal?.aborted) throw new InferenceFailure('cancelled', 'Grok grant wait cancelled');
      if (this.closed) throw new InferenceFailure('unavailable', 'Grok grant pool is closed');
      let lane = this.lanes.find(candidate => candidate.key === key && !candidate.busy);
      if (lane === undefined && this.lanes.filter(candidate => candidate.key === key).length < this.lanesPerRoute) {
        if (this.lanes.length >= authority.maxLiveGrants) {
          const evict = this.lanes.find(candidate => !candidate.busy);
          if (evict !== undefined) this.drop(evict);
        }
        if (this.lanes.length < authority.maxLiveGrants) { lane = { key, spec, requests: 0, tokens: 0, busy: false }; this.lanes.push(lane); }
      }
      if (lane === undefined) { await this.changed(signal); continue; }
      lane.busy = true;
      clearTimeout(lane.idle);
      try { return await this.lease(authority, lane, needMs, signal); }
      catch (error) { this.drop(lane); throw error; }
    }
  }

  /** Release every grant; in-flight lanes release theirs when they settle. */
  async close(): Promise<void> {
    this.closed = true;
    const idle = this.lanes.filter(lane => !lane.busy);
    await Promise.all(idle.map(lane => this.drop(lane)));
    this.wake();
  }

  private authority(): Promise<GrokInferenceGrantAuthority> {
    this.resolved ??= this.options.authority().catch((error: unknown) => {
      throw error instanceof InferenceFailure ? error : new InferenceFailure('unsupported', 'Grok broker-grant inference is unavailable (no broker control socket or client pin)');
    });
    return this.resolved;
  }

  private async lease(authority: GrokInferenceGrantAuthority, lane: Lane, needMs: number, signal?: AbortSignal): Promise<GrokGrantLease> {
    if (lane.grant !== undefined && !this.usable(lane, needMs)) {
      const stale = lane.grant; lane.grant = undefined;
      await this.release(authority, stale.grantId);
    }
    let delay = this.backoff[0];
    while (lane.grant === undefined) {
      if (signal?.aborted) throw new InferenceFailure('cancelled', 'Grok grant wait cancelled');
      try {
        const grant = await authority.request(lane.spec);
        const expires = Date.parse(grant.expiresAt);
        if (grant.model !== lane.spec.model || grant.reasoningEffort !== lane.spec.reasoningEffort || grant.purpose !== lane.spec.purpose ||
          !Number.isFinite(expires) || typeof grant.token !== 'string' || !grant.token) {
          await this.release(authority, grant.grantId);
          throw new InferenceFailure('unavailable', 'Grok broker returned a grant that does not match the request');
        }
        lane.grant = grant; lane.requests = 0; lane.tokens = 0;
      } catch (error) {
        if (error instanceof GrokGrantRefusal && error.code === 'grant_limit') {
          await sleep(delay, signal);
          delay = Math.min(delay * 2, this.backoff[1]);
          continue;
        }
        throw classify(error);
      }
    }
    const grant = lane.grant;
    const callTimeoutMs = Math.min(needMs, Date.parse(grant.expiresAt) - this.now() - this.renewMarginMs);
    if (callTimeoutMs < 1) throw new InferenceFailure('unavailable', 'Grok grant expires before the call could run');
    let settled = false;
    return { authority, grant, callTimeoutMs, settle: async outcome => {
      if (settled) return;
      settled = true;
      if (!outcome.ok || this.closed) { await this.drop(lane); return; }
      lane.requests += 1;
      lane.tokens = outcome.tokens === null ? Number.POSITIVE_INFINITY : lane.tokens + outcome.tokens;
      lane.busy = false;
      lane.idle = setTimeout(() => { void this.drop(lane); }, this.idleReleaseMs);
      lane.idle.unref?.();
      this.wake();
    } };
  }

  private usable(lane: Lane, needMs: number): boolean {
    const grant = lane.grant!;
    return Date.parse(grant.expiresAt) - this.now() - this.renewMarginMs >= needMs &&
      lane.requests < grant.limits.maxRequests &&
      lane.tokens + Math.min(this.reserve, grant.limits.maxTokens) <= grant.limits.maxTokens;
  }

  /** Removes the lane synchronously (freeing its slot), then releases its grant best-effort. */
  private drop(lane: Lane): Promise<void> {
    const index = this.lanes.indexOf(lane);
    if (index >= 0) this.lanes.splice(index, 1);
    clearTimeout(lane.idle);
    const grant = lane.grant; lane.grant = undefined;
    this.wake();
    return grant === undefined || this.resolved === undefined ? Promise.resolve()
      : this.resolved.then(authority => this.release(authority, grant.grantId), () => undefined);
  }

  /** Bounded and silent: an unreleased grant still expires at the broker. */
  private async release(authority: GrokInferenceGrantAuthority, grantId: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([authority.release(grantId), new Promise(resolve => { timer = setTimeout(resolve, this.releaseTimeoutMs); })]);
    } catch { /* expiry frees the slot */ } finally { clearTimeout(timer); }
  }

  private changed(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
      const abort = () => { this.waiters = this.waiters.filter(waiter => waiter !== done); reject(new InferenceFailure('cancelled', 'Grok grant wait cancelled')); };
      signal?.addEventListener('abort', abort, { once: true });
      this.waiters.push(done);
    });
  }

  private wake(): void { const waiters = this.waiters; this.waiters = []; for (const waiter of waiters) waiter(); }
}

function classify(error: unknown): InferenceFailure {
  if (error instanceof InferenceFailure) return error;
  if (error instanceof GrokGrantRefusal) {
    if (error.code === 'auth_stale') return new InferenceFailure('auth-stale', 'Grok broker credential realm is stale');
    if (error.code === 'invalid_request') return new InferenceFailure('unsupported', 'Grok broker refused the grant request as invalid');
  }
  return new InferenceFailure('unavailable', 'Grok broker is unavailable');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(new InferenceFailure('cancelled', 'Grok grant wait cancelled')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
