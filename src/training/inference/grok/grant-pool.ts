import { GrokGrantRefusal, type GrokGrantModel, type GrokGrantPurpose, type GrokGrantReasoningEffort,
  type GrokInferenceGrant, type GrokInferenceGrantAuthority } from '../../contracts/inference-grants.js';
import { InferenceFailure } from '../failure.js';
import { GrokGrantReleases } from './grant-releases.js';

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
  /** Bound on one release exchange; failed releases retry `releaseAttempts` times with `releaseBackoffMs`. */
  releaseTimeoutMs?: number;
  releaseAttempts?: number;
  releaseBackoffMs?: readonly [initial: number, maximum: number];
  /** Bound on {@link GrokGrantPool.close} waiting for in-flight lanes and releases. */
  closeTimeoutMs?: number;
  now?: () => number;
}

export type GrokGrantOutcome = Readonly<{ ok: true; tokens: number | null }> | Readonly<{ ok: false }>;
export interface GrokGrantLease {
  readonly authority: GrokInferenceGrantAuthority;
  readonly grant: GrokInferenceGrant;
  /** Time the CLI call may take without outliving the grant or the call deadline. */
  readonly callTimeoutMs: number;
  /** Exactly once: success keeps the grant for this lane's next call; failure releases it. */
  settle(outcome: GrokGrantOutcome): Promise<void>;
}

interface Lane { key: string; spec: GrokGrantKey; grant?: GrokInferenceGrant; requests: number; tokens: number; busy: boolean; idle?: ReturnType<typeof setTimeout> }

/**
 * One grant per concurrent lane, reused sequentially until it nears expiry or
 * its request/token ceilings, then renewed. Never holds more grants than the
 * broker's live-grant cap, counting released grants until the broker confirms
 * them or they expire. On `grant_limit` a lane queues with backoff; every wait
 * ends at the call deadline (`timeout`) or the caller's signal (`cancelled`).
 * Grants are released on any failure, when idle, and on close.
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
  private readonly closeTimeoutMs: number;
  private readonly releases: GrokGrantReleases;
  private readonly now: () => number;

  constructor(private readonly options: GrokGrantPoolOptions) {
    this.id = options.id;
    this.lanesPerRoute = options.lanesPerRoute ?? 2;
    this.idleReleaseMs = options.idleReleaseMs ?? 30_000;
    this.renewMarginMs = options.renewMarginMs ?? 5_000;
    this.reserve = options.requestTokenReserve ?? 500_000;
    this.backoff = options.capBackoffMs ?? [250, 2_000];
    this.closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
    this.now = options.now ?? Date.now;
    if (!options.id.trim() || !Number.isSafeInteger(this.lanesPerRoute) || this.lanesPerRoute < 1 || this.lanesPerRoute > 8) throw new Error('Invalid Grok grant pool policy');
    this.releases = new GrokGrantReleases({ now: this.now, attempts: options.releaseAttempts ?? 4, backoffMs: options.releaseBackoffMs ?? [250, 2_000],
      attemptTimeoutMs: options.releaseTimeoutMs ?? 2_000, onChange: () => this.wake() });
  }

  /** `needMs` is the call's whole budget: waiting for a lane or grant spends it, and the CLI gets what remains. */
  async acquire(spec: GrokGrantKey, needMs: number, signal?: AbortSignal): Promise<GrokGrantLease> {
    const deadline = this.now() + needMs;
    const authority = await this.authority();
    const key = `${spec.model}\0${spec.reasoningEffort}\0${spec.purpose}`;
    for (;;) {
      if (signal?.aborted) throw cancelled();
      if (this.closed) throw new InferenceFailure('unavailable', 'Grok grant pool is closed');
      if (this.now() >= deadline) throw expired();
      let lane = this.lanes.find(candidate => candidate.key === key && !candidate.busy);
      if (lane === undefined && this.lanes.filter(candidate => candidate.key === key).length < this.lanesPerRoute) {
        if (this.lanes.length + this.releases.count() < authority.maxLiveGrants) {
          lane = { key, spec, requests: 0, tokens: 0, busy: false }; this.lanes.push(lane);
        } else {
          const evict = this.lanes.find(candidate => !candidate.busy);
          if (evict !== undefined) { await this.drop(evict); continue; }
        }
      }
      if (lane === undefined) { await this.bound(this.changed(), signal, deadline); continue; }
      lane.busy = true;
      clearTimeout(lane.idle);
      try { return await this.lease(authority, lane, deadline, signal); }
      catch (error) { await this.drop(lane); throw error; }
    }
  }

  /** Release every grant, waiting (bounded) for in-flight lanes to settle and releases to be confirmed. */
  async close(): Promise<void> {
    this.closed = true;
    const deadline = this.now() + this.closeTimeoutMs;
    await Promise.all(this.lanes.filter(lane => !lane.busy).map(lane => this.drop(lane)));
    this.wake();
    const drained = (async () => { while (this.lanes.length) await this.changed(); await this.releases.settled(); })();
    await this.bound(drained, undefined, deadline).catch(() => undefined);
  }

  private authority(): Promise<GrokInferenceGrantAuthority> {
    this.resolved ??= this.options.authority().catch((error: unknown) => {
      throw error instanceof InferenceFailure ? error : new InferenceFailure('unsupported', 'Grok broker-grant inference is unavailable (no broker control socket or client pin)');
    });
    return this.resolved;
  }

  private async lease(authority: GrokInferenceGrantAuthority, lane: Lane, deadline: number, signal?: AbortSignal): Promise<GrokGrantLease> {
    if (lane.grant !== undefined && !this.usable(lane, deadline)) {
      const stale = lane.grant; lane.grant = undefined;
      await this.releases.release(authority, stale);
    }
    let delay = this.backoff[0];
    while (lane.grant === undefined) {
      try {
        const grant = await this.bound(authority.request(lane.spec), signal, deadline, late => { void this.releases.release(authority, late); });
        const expires = Date.parse(grant.expiresAt);
        if (grant.model !== lane.spec.model || grant.reasoningEffort !== lane.spec.reasoningEffort || grant.purpose !== lane.spec.purpose ||
          !Number.isFinite(expires) || typeof grant.token !== 'string' || !grant.token) {
          await this.releases.release(authority, grant);
          throw new InferenceFailure('unavailable', 'Grok broker returned a grant that does not match the request');
        }
        lane.grant = grant; lane.requests = 0; lane.tokens = 0;
      } catch (error) {
        if (error instanceof GrokGrantRefusal && error.code === 'grant_limit') {
          await this.bound(new Promise(resolve => setTimeout(resolve, delay)), signal, deadline);
          delay = Math.min(delay * 2, this.backoff[1]);
          continue;
        }
        throw classify(error);
      }
    }
    const grant = lane.grant;
    const now = this.now();
    const callTimeoutMs = Math.min(deadline - now, Date.parse(grant.expiresAt) - now - this.renewMarginMs);
    if (deadline - now < 1) throw expired();
    if (callTimeoutMs < 1) throw new InferenceFailure('unavailable', 'Grok grant expires before the call could run');
    let settled = false;
    return { authority, grant, callTimeoutMs, settle: async outcome => {
      if (settled) return;
      settled = true;
      if (!outcome.ok || this.closed) { await this.drop(lane); return; }
      lane.requests += 1;
      lane.tokens = outcome.tokens === null ? Number.POSITIVE_INFINITY : lane.tokens + outcome.tokens;
      lane.busy = false;
      // Unref'd: shutdown releases through close(), which training awaits on every exit path.
      lane.idle = setTimeout(() => { void this.drop(lane); }, this.idleReleaseMs);
      lane.idle.unref?.();
      this.wake();
    } };
  }

  private usable(lane: Lane, deadline: number): boolean {
    const grant = lane.grant!;
    return Date.parse(grant.expiresAt) - this.renewMarginMs >= deadline &&
      lane.requests < grant.limits.maxRequests &&
      lane.tokens + Math.min(this.reserve, grant.limits.maxTokens) <= grant.limits.maxTokens;
  }

  /** Removes the lane; its grant stays counted until the broker confirms the release or the grant expires. */
  private async drop(lane: Lane): Promise<void> {
    const index = this.lanes.indexOf(lane);
    if (index >= 0) this.lanes.splice(index, 1);
    clearTimeout(lane.idle);
    const grant = lane.grant; lane.grant = undefined;
    if (grant !== undefined && this.resolved !== undefined) {
      const authority = await this.resolved.catch(() => undefined);
      if (authority !== undefined) await this.releases.release(authority, grant);
    }
    this.wake();
  }

  private changed(): Promise<void> { return new Promise(resolve => { this.waiters.push(resolve); }); }

  /** Waits for `pending` unless the caller cancels or the deadline passes; a late grant is handed to `orphan`. */
  private bound<T>(pending: Promise<T>, signal: AbortSignal | undefined, deadline: number, orphan?: (value: T) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (settle: () => void): boolean => {
        if (done) return false;
        done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); settle(); return true;
      };
      const leave = (failure: InferenceFailure) => { if (finish(() => reject(failure))) pending.then(value => orphan?.(value), () => undefined); };
      const abort = () => leave(cancelled());
      const timer = setTimeout(() => leave(expired()), Math.max(0, deadline - this.now()));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      pending.then(value => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)));
    });
  }

  private wake(): void { const waiters = this.waiters; this.waiters = []; for (const waiter of waiters) waiter(); }
}

const cancelled = () => new InferenceFailure('cancelled', 'Grok grant wait cancelled');
/** Routing treats `timeout` like other capacity failures: the next authored route may run inside the route budget. */
const expired = () => new InferenceFailure('timeout', 'Grok grant capacity wait exceeded the call deadline');

function classify(error: unknown): InferenceFailure {
  if (error instanceof InferenceFailure) return error;
  if (error instanceof GrokGrantRefusal) {
    if (error.code === 'auth_stale') return new InferenceFailure('auth-stale', 'Grok broker credential realm is stale');
    if (error.code === 'invalid_request') return new InferenceFailure('unsupported', 'Grok broker refused the grant request as invalid');
  }
  return new InferenceFailure('unavailable', 'Grok broker is unavailable');
}
