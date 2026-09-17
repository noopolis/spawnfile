import { describe, expect, it } from 'vitest';
import { GrokGrantRefusal } from '../../contracts/inference-grants.js';
import { fakeGrantAuthority } from './grant-fixtures.js';
import { GrokGrantPool, type GrokGrantKey } from './grant-pool.js';

const judge: GrokGrantKey = { model: 'grok-4.6', reasoningEffort: 'low', purpose: 'judge' };
const optimizer: GrokGrantKey = { model: 'grok-4.6', reasoningEffort: 'medium', purpose: 'optimizer' };
const pool = (fake: ReturnType<typeof fakeGrantAuthority>, patch: Partial<ConstructorParameters<typeof GrokGrantPool>[0]> = {}) =>
  new GrokGrantPool({ id: '/run/daimon-engine-broker/control.sock', authority: async () => fake.authority, capBackoffMs: [1, 4], ...patch });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

describe('lanes', () => {
  it('holds one grant per concurrent lane, reuses it sequentially and queues beyond the lane count', async () => {
    const fake = fakeGrantAuthority();
    const grants = pool(fake);
    const [a, b] = await Promise.all([grants.acquire(judge, 1000), grants.acquire(judge, 1000)]);
    expect(fake.requests).toHaveLength(2);
    expect(a.grant.grantId).not.toBe(b.grant.grantId);
    let third: string | undefined;
    const waiting = grants.acquire(judge, 1000).then(lease => { third = lease.grant.grantId; return lease; });
    await tick();
    expect(third).toBeUndefined();
    await a.settle({ ok: true, tokens: 100 });
    const c = await waiting;
    expect(c.grant.grantId).toBe(a.grant.grantId);
    expect(fake.requests).toHaveLength(2);
    expect(fake.releases).toEqual([]);
    await c.settle({ ok: true, tokens: 1 }); await c.settle({ ok: false });
    expect(fake.releases).toEqual([]);
    await b.settle({ ok: true, tokens: 1 });
    await grants.close();
    expect(fake.releases.sort()).toEqual([a.grant.grantId, b.grant.grantId].sort());
    await expect(grants.acquire(judge, 1000)).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('never exceeds the live-grant cap: another route waits, then evicts an idle lane', async () => {
    const fake = fakeGrantAuthority({ maxLiveGrants: 2 });
    const grants = pool(fake);
    const [a, b] = await Promise.all([grants.acquire(judge, 1000), grants.acquire(judge, 1000)]);
    let other: string | undefined;
    const waiting = grants.acquire(optimizer, 1000).then(lease => { other = lease.grant.grantId; return lease; });
    await tick();
    expect(other).toBeUndefined();
    expect(fake.requests).toHaveLength(2);
    await a.settle({ ok: true, tokens: 5 });
    const lease = await waiting;
    expect(fake.releases).toEqual([a.grant.grantId]);
    expect(fake.requests.at(-1)).toEqual(optimizer);
    await lease.settle({ ok: false }); await b.settle({ ok: false });
    expect(fake.releases).toHaveLength(3);
  });

  it('releases a failed lane grant and requests a fresh one next time', async () => {
    const fake = fakeGrantAuthority();
    const grants = pool(fake);
    const first = await grants.acquire(judge, 1000);
    await first.settle({ ok: false });
    expect(fake.releases).toEqual([first.grant.grantId]);
    const second = await grants.acquire(judge, 1000);
    expect(second.grant.grantId).not.toBe(first.grant.grantId);
    await second.settle({ ok: true, tokens: 1 });
    await grants.close();
    const busy = fakeGrantAuthority(); const closing = pool(busy);
    const held = await closing.acquire(judge, 1000);
    await closing.close();
    expect(busy.releases).toEqual([]);
    await held.settle({ ok: true, tokens: 1 });
    expect(busy.releases).toEqual([held.grant.grantId]);
  });

  it('releases an idle lane grant so other evaluators can use the slot', async () => {
    const fake = fakeGrantAuthority();
    const lease = await pool(fake, { idleReleaseMs: 1 }).acquire(judge, 1000);
    await lease.settle({ ok: true, tokens: 1 });
    await tick(); await tick();
    expect(fake.releases).toEqual([lease.grant.grantId]);
  });
});

describe('renewal', () => {
  it('renews before the TTL margin would cut the next call short', async () => {
    let now = 1_000_000;
    const fake = fakeGrantAuthority({ ttlMs: 10_000, now: () => now });
    const grants = pool(fake, { now: () => now, renewMarginMs: 1_000 });
    const first = await grants.acquire(judge, 5_000);
    expect(first.callTimeoutMs).toBe(5_000);
    await first.settle({ ok: true, tokens: 10 });
    now += 3_000;
    const reused = await grants.acquire(judge, 5_000);
    expect(reused.grant.grantId).toBe(first.grant.grantId);
    await reused.settle({ ok: true, tokens: 10 });
    now += 2_000;
    const renewed = await grants.acquire(judge, 5_000);
    expect(renewed.grant.grantId).not.toBe(first.grant.grantId);
    expect(fake.releases).toEqual([first.grant.grantId]);
    const long = await pool(fake, { now: () => now, renewMarginMs: 1_000 }).acquire(judge, 60_000);
    expect(long.callTimeoutMs).toBe(9_000);
    await renewed.settle({ ok: false }); await long.settle({ ok: false });
  });

  it('renews before request or token ceilings and after unknown usage', async () => {
    const fake = fakeGrantAuthority();
    const limited = { ...fake.authority, request: async (input: GrokGrantKey) => ({ ...await fake.authority.request(input), limits: { maxRequests: 2, maxTokens: 1_000, timeoutMs: 600_000 } }) };
    const grants = new GrokGrantPool({ id: 'sock', authority: async () => limited, requestTokenReserve: 400, lanesPerRoute: 1 });
    const ids: string[] = [];
    for (const tokens of [100, 100, 500, null, 1]) {
      const lease = await grants.acquire(judge, 1000);
      ids.push(lease.grant.grantId);
      await lease.settle({ ok: true, tokens });
    }
    // Two requests used → renew; 500 tokens + 400 reserve ≤ 1000 still fits once; unknown usage → renew.
    const [g1, g2, g3] = [...new Set(ids)];
    expect(ids).toEqual([g1, g1, g2, g2, g3]);
    expect(new Set(ids).size).toBe(3);
    await grants.close();
  });

  it('refuses a grant that expires before a call could run and releases it', async () => {
    const fake = fakeGrantAuthority({ ttlMs: 500 });
    await expect(pool(fake, { renewMarginMs: 1_000 }).acquire(judge, 1000)).rejects.toMatchObject({ kind: 'unavailable' });
    expect(fake.releases).toHaveLength(1);
  });
});

describe('broker refusals', () => {
  it('queues on the broker live-grant cap instead of failing, until the caller gives up', async () => {
    const fake = fakeGrantAuthority({ refusals: [new GrokGrantRefusal('grant_limit'), new GrokGrantRefusal('grant_limit')] });
    const lease = await pool(fake).acquire(judge, 1000);
    expect(fake.requests).toHaveLength(3);
    await lease.settle({ ok: false });
    const capped = fakeGrantAuthority({ refusals: Array.from({ length: 1000 }, () => new GrokGrantRefusal('grant_limit')) });
    const controller = new AbortController();
    const waiting = pool(capped, { capBackoffMs: [2, 2] }).acquire(judge, 1000, controller.signal);
    await tick(); controller.abort();
    await expect(waiting).rejects.toMatchObject({ kind: 'cancelled' });
    expect(capped.requests.length).toBeGreaterThan(1);
  });

  it('fails auth_stale fast without retrying and classifies other refusals', async () => {
    const stale = fakeGrantAuthority({ refusals: [new GrokGrantRefusal('auth_stale')] });
    await expect(pool(stale).acquire(judge, 1000)).rejects.toMatchObject({ kind: 'auth-stale' });
    expect(stale.requests).toHaveLength(1);
    for (const [error, kind] of [[new GrokGrantRefusal('invalid_request'), 'unsupported'], [new GrokGrantRefusal('unavailable'), 'unavailable'], [new Error('socket'), 'unavailable']] as const) {
      const fake = fakeGrantAuthority({ request: async () => { throw error; } });
      await expect(pool(fake).acquire(judge, 1000)).rejects.toMatchObject({ kind });
    }
  });

  it('releases a grant that does not echo the requested policy', async () => {
    const fake = fakeGrantAuthority();
    const wrong = { ...fake.authority, request: async (input: GrokGrantKey) => ({ ...await fake.authority.request(input), model: 'grok-build' as const }) };
    await expect(new GrokGrantPool({ id: 'sock', authority: async () => wrong }).acquire(judge, 1000)).rejects.toMatchObject({ kind: 'unavailable' });
    expect(fake.releases).toHaveLength(1);
    const blank = { ...fake.authority, request: async (input: GrokGrantKey) => ({ ...await fake.authority.request(input), token: '' }) };
    await expect(new GrokGrantPool({ id: 'sock', authority: async () => blank }).acquire(judge, 1000)).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('fails closed when the broker authority cannot be resolved, and bounds a hanging release', async () => {
    let resolutions = 0;
    const missing = new GrokGrantPool({ id: 'sock', authority: async () => { resolutions++; throw new Error('no socket'); } });
    await expect(missing.acquire(judge, 1000)).rejects.toMatchObject({ kind: 'unsupported' });
    await expect(missing.acquire(judge, 1000)).rejects.toMatchObject({ kind: 'unsupported' });
    expect(resolutions).toBe(1);
    const fake = fakeGrantAuthority({ release: () => new Promise(() => undefined) });
    const hanging = pool(fake, { releaseTimeoutMs: 1 });
    const lease = await hanging.acquire(judge, 1000);
    await lease.settle({ ok: false });
    const cancelled = new AbortController(); cancelled.abort();
    await expect(hanging.acquire(judge, 1000, cancelled.signal)).rejects.toMatchObject({ kind: 'cancelled' });
    expect(() => new GrokGrantPool({ id: ' ', authority: async () => fake.authority })).toThrow('Invalid');
    expect(() => new GrokGrantPool({ id: 'x', authority: async () => fake.authority, lanesPerRoute: 9 })).toThrow('Invalid');
  });

  it('cancels a caller waiting for a busy lane', async () => {
    const fake = fakeGrantAuthority();
    const grants = pool(fake, { lanesPerRoute: 1 });
    const held = await grants.acquire(judge, 1000);
    const controller = new AbortController();
    const waiting = grants.acquire(judge, 1000, controller.signal);
    await tick(); controller.abort();
    await expect(waiting).rejects.toMatchObject({ kind: 'cancelled' });
    await held.settle({ ok: true, tokens: 1 });
    const next = await grants.acquire(judge, 1000);
    expect(next.grant.grantId).toBe(held.grant.grantId);
    await grants.close(); await next.settle({ ok: false });
  });
});
