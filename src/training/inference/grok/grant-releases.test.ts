import { describe, expect, it } from 'vitest';
import { GrokGrantRefusal } from '../../contracts/inference-grants.js';
import { fakeGrantAuthority } from './grant-fixtures.js';
import { GrokGrantReleases } from './grant-releases.js';
import { GrokGrantPool, type GrokGrantKey } from './grant-pool.js';

const judge: GrokGrantKey = { model: 'grok-4.6', reasoningEffort: 'low', purpose: 'judge' };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** A broker whose releases fail `failures` times (or forever), then confirm. */
function flakyRelease(fake: ReturnType<typeof fakeGrantAuthority>, failures = Number.POSITIVE_INFINITY) {
  let attempts = 0;
  fake.authority.release = async grantId => { attempts++; if (attempts <= failures) throw new Error('broker busy'); fake.releases.push(grantId); return true; };
  return () => attempts;
}

describe('unconfirmed releases stay counted against the live-grant cap', () => {
  it('keeps a failed release counted until its TTL, retrying with bounded backoff', async () => {
    const fake = fakeGrantAuthority({ maxLiveGrants: 2, ttlMs: 400 });
    const attempts = flakyRelease(fake);
    const pool = new GrokGrantPool({ id: 's', authority: async () => fake.authority, renewMarginMs: 10, releaseAttempts: 3, releaseBackoffMs: [5, 10] });
    const failed = await pool.acquire(judge, 100);
    await failed.settle({ ok: false });
    const held = await pool.acquire(judge, 100);
    // One lane plus one unconfirmed release fill the cap of two: a second lane must wait, here until its deadline.
    await expect(pool.acquire(judge, 60)).rejects.toMatchObject({ kind: 'timeout' });
    expect(fake.requests).toHaveLength(2);
    await sleep(60);
    expect(attempts()).toBe(3);
    await sleep(350);
    const freed = await pool.acquire(judge, 100);
    expect(fake.requests).toHaveLength(3);
    await held.settle({ ok: true, tokens: 1 }); await freed.settle({ ok: true, tokens: 1 });
  });

  it('frees the slot as soon as a retried release is confirmed', async () => {
    const fake = fakeGrantAuthority({ maxLiveGrants: 1 });
    const attempts = flakyRelease(fake, 1);
    const pool = new GrokGrantPool({ id: 's', authority: async () => fake.authority, releaseBackoffMs: [20, 20] });
    const first = await pool.acquire(judge, 5_000);
    await first.settle({ ok: false });
    const second = await pool.acquire(judge, 5_000);
    expect(attempts()).toBe(2);
    expect(fake.releases).toEqual([first.grant.grantId]);
    await second.settle({ ok: false });
  });
});

describe('shutdown', () => {
  it('close releases every live grant, including lanes that settle while closing, and confirms retried releases', async () => {
    const fake = fakeGrantAuthority();
    const attempts = flakyRelease(fake, 1);
    const pool = new GrokGrantPool({ id: 's', authority: async () => fake.authority, releaseBackoffMs: [5, 5] });
    const [idle, busy] = await Promise.all([pool.acquire(judge, 5_000), pool.acquire(judge, 5_000)]);
    await idle.settle({ ok: true, tokens: 1 });
    const closing = pool.close();
    // Settles while close is waiting; when close resolves every release must already be confirmed.
    void busy.settle({ ok: true, tokens: 1 });
    await closing;
    expect(fake.releases.sort()).toEqual([idle.grant.grantId, busy.grant.grantId].sort());
    expect(attempts()).toBe(3);
  });

  it('bounds close when a lane never settles or the broker never answers', async () => {
    const fake = fakeGrantAuthority();
    fake.authority.release = () => new Promise(() => undefined);
    const pool = new GrokGrantPool({ id: 's', authority: async () => fake.authority, closeTimeoutMs: 30, releaseTimeoutMs: 5, releaseAttempts: 1 });
    const lease = await pool.acquire(judge, 5_000);
    await pool.acquire(judge, 5_000).then(other => other.settle({ ok: true, tokens: 1 }));
    const started = Date.now();
    await pool.close();
    expect(Date.now() - started).toBeLessThan(1_000);
    await lease.settle({ ok: false });
  });
});

describe('call deadline', () => {
  it('fails a cap held forever at the call deadline without a signal', async () => {
    const fake = fakeGrantAuthority({ refusals: Array.from({ length: 10_000 }, () => new GrokGrantRefusal('grant_limit')) });
    const pool = new GrokGrantPool({ id: 's', authority: async () => fake.authority, capBackoffMs: [5, 10] });
    const started = Date.now();
    await expect(pool.acquire(judge, 80)).rejects.toMatchObject({ kind: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fake.requests.length).toBeGreaterThan(1);
  });

  it('fails a busy-lane wait and a broker that never answers at the deadline, spending the budget before the CLI', async () => {
    const fake = fakeGrantAuthority();
    const pool = new GrokGrantPool({ id: 's', authority: async () => fake.authority, lanesPerRoute: 1 });
    const held = await pool.acquire(judge, 5_000);
    await expect(pool.acquire(judge, 30)).rejects.toMatchObject({ kind: 'timeout' });
    await held.settle({ ok: true, tokens: 1 });
    await sleep(20);
    const reused = await pool.acquire(judge, 1_000);
    expect(reused.callTimeoutMs).toBeLessThanOrEqual(1_000);
    await reused.settle({ ok: false });
    const silent = fakeGrantAuthority();
    const request = silent.authority.request;
    let answer!: () => void;
    silent.authority.request = input => new Promise(resolve => { answer = () => { void request(input).then(resolve); }; });
    await expect(new GrokGrantPool({ id: 's', authority: async () => silent.authority }).acquire(judge, 30)).rejects.toMatchObject({ kind: 'timeout' });
    answer(); await sleep(10);
    expect(silent.releases).toHaveLength(1);
  });
});

describe('release bookkeeping', () => {
  const tracker = (now: () => number, authority = fakeGrantAuthority()) => {
    const changes: number[] = [];
    return { authority, changes, releases: new GrokGrantReleases({ now, attempts: 1, backoffMs: [1, 1], attemptTimeoutMs: 5, onChange: () => changes.push(now()) }) };
  };

  it('stops counting a grant once its TTL passes, even when no release was confirmed', async () => {
    let now = 1_000;
    const silent = fakeGrantAuthority();
    silent.authority.release = () => new Promise(() => undefined);
    const { releases, changes } = tracker(() => now, silent);
    await releases.release(silent.authority, { grantId: 'a', expiresAt: new Date(now + 50).toISOString() });
    expect(releases.count()).toBe(1);
    now += 60;
    expect(releases.count()).toBe(0);
    expect(changes).toEqual([1_060]);
    await releases.settled();
    expect(releases.count()).toBe(0);
  });

  it('ignores a duplicate, already expired or unparsable grant instead of counting it twice', async () => {
    const now = 1_000;
    const { releases, authority } = tracker(() => now);
    const live = { grantId: 'b', expiresAt: new Date(now + 5_000).toISOString() };
    authority.authority.release = () => new Promise(() => undefined);
    await releases.release(authority.authority, live);
    await releases.release(authority.authority, live);
    await releases.release(authority.authority, { grantId: 'c', expiresAt: new Date(now - 1).toISOString() });
    await releases.release(authority.authority, { grantId: 'd', expiresAt: 'not-a-date' });
    expect(releases.count()).toBe(1);
  });
});

