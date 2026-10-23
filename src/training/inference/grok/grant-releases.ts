import type { GrokInferenceGrant, GrokInferenceGrantAuthority } from '../../contracts/inference-grants.js';

export interface GrokGrantReleaseOptions {
  now: () => number;
  /** Release attempts before an unconfirmed grant simply waits out its TTL (still counted). */
  attempts: number;
  backoffMs: readonly [initial: number, maximum: number];
  /** Bound on one release exchange with the broker. */
  attemptTimeoutMs: number;
  /** A counted grant stopped counting (confirmed or expired). */
  onChange: () => void;
}

/**
 * Grants handed back to the broker. Until the broker confirms a release (either
 * answer: `released:false` means it no longer holds the grant) or the grant's
 * TTL passes, it still occupies one of the broker's live-grant slots, so it stays
 * counted against the local cap. Failed releases retry with bounded backoff.
 */
export class GrokGrantReleases {
  private readonly pending = new Map<string, { expires: number; timer: ReturnType<typeof setTimeout> }>();
  private readonly loops = new Set<Promise<void>>();

  constructor(private readonly options: GrokGrantReleaseOptions) {}

  /** Grants the broker may still count. */
  count(): number {
    const now = this.options.now();
    for (const [grantId, entry] of this.pending) if (entry.expires <= now) this.forget(grantId);
    return this.pending.size;
  }

  /** Resolves after the first attempt; retries continue in the background (see {@link settled}). */
  release(authority: GrokInferenceGrantAuthority, grant: Pick<GrokInferenceGrant, 'grantId' | 'expiresAt'>): Promise<void> {
    const expires = Date.parse(grant.expiresAt);
    const remaining = expires - this.options.now();
    if (this.pending.has(grant.grantId) || !Number.isFinite(expires) || remaining <= 0) return Promise.resolve();
    // Expiry frees the broker slot even if no release was ever confirmed.
    const timer = setTimeout(() => this.forget(grant.grantId), Math.min(remaining, 2_147_483_647));
    timer.unref?.();
    this.pending.set(grant.grantId, { expires, timer });
    let firstAttempt!: () => void;
    const first = new Promise<void>(resolve => { firstAttempt = resolve; });
    const loop = (async () => {
      let delay = this.options.backoffMs[0];
      for (let attempt = 1; this.pending.has(grant.grantId); attempt++) {
        const confirmed = await this.attempt(authority, grant.grantId);
        if (attempt === 1) firstAttempt();
        if (confirmed) { this.forget(grant.grantId); return; }
        if (attempt >= this.options.attempts || this.options.now() + delay >= expires) return;
        await new Promise(resolve => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, this.options.backoffMs[1]);
      }
    })().finally(() => { firstAttempt(); this.loops.delete(loop); });
    this.loops.add(loop);
    return first;
  }

  /** Every release attempt sequence has finished (confirmed, exhausted or expired). */
  async settled(): Promise<void> {
    while (this.loops.size) await Promise.all([...this.loops]);
  }

  private async attempt(authority: GrokInferenceGrantAuthority, grantId: string): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([authority.release(grantId).then(() => true),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), this.options.attemptTimeoutMs); })]);
    } catch { return false; } finally { clearTimeout(timer); }
  }

  private forget(grantId: string): void {
    const entry = this.pending.get(grantId);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.pending.delete(grantId);
    this.options.onChange();
  }
}
