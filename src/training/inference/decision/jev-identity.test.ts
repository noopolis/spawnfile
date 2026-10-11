import { expect, it, vi } from 'vitest';
import type { DecisionRequest } from '../../contracts/grading.js';
import { createJevDecision } from './index.js';

const endpoint = 'http://localhost/jev';
const request: DecisionRequest = { key: 'q', type: 'yes-no', optionLabels: ['yes', 'no'], instructions: 'Claim?', projection: {} };
function server(options: { refuseLong?: boolean; status?: number; probability?: number; declared?: Record<string, unknown> } = {}) {
  return vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(init!.body as string) as { state: string; questions: Record<string, unknown> };
    if (body.state.length > 30_000 && options.status) return new Response('{}', { status: options.status });
    if (body.state.length > 30_000 && options.refuseLong) return new Response(JSON.stringify(options.declared ?? {}), { status: 422 });
    const p = options.probability ?? 0.8;
    return new Response(JSON.stringify({ model: 'm', ...options.declared,
      answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { probabilities: { true: p, false: 1 - p } }])) }));
  });
}

it('distinguishes a truncating server from a refusing server using the long canary', async () => {
  const truncating = server();
  const refusing = server({ refuseLong: true });
  const truncationIdentity = await createJevDecision({ endpoint, fetch: truncating }).identity();
  const refusalIdentity = await createJevDecision({ endpoint, fetch: refusing }).identity();
  expect(refusalIdentity.model).toBe(truncationIdentity.model);
  expect(refusalIdentity.fingerprint).not.toBe(truncationIdentity.fingerprint);
  for (const fetch of [truncating, refusing]) {
    const bodies = fetch.mock.calls.map(call => JSON.parse(call[1]!.body as string) as { state: string; questions: Record<string, { type: string }> });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.state).toBe('{}');
    expect(bodies[1]!.state.length).toBeGreaterThanOrEqual(40_000);
    expect(bodies[1]!.state.length).toBeLessThan(40_100);
    expect(Object.values(bodies[1]!.questions)).toHaveLength(1);
    expect(Object.values(bodies[1]!.questions)[0]!.type).toBe('noul');
  }
  expect(truncating.mock.calls.map(call => call[1]!.body)).toEqual(refusing.mock.calls.map(call => call[1]!.body));
});

it('reuses both canaries once per backend instance, including concurrent and final reads', async () => {
  const options = { probability: 0.800049 };
  const fetch = server(options);
  const backend = createJevDecision({ endpoint, fetch });
  const [initial, concurrent] = await Promise.all([backend.identity(), backend.identity()]);
  expect(concurrent).toEqual(initial);
  expect(fetch).toHaveBeenCalledTimes(2);
  options.probability = 0.800051;
  expect((await backend.score([request]))[0]?.status).toBe('ok');
  expect(await backend.identity()).toEqual(initial);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(await createJevDecision({ endpoint, fetch: server({ probability: 0.800051 }) }).identity()).toEqual(initial);
  expect(await createJevDecision({ endpoint, fetch: server({ probability: 0.2 }) }).identity()).not.toEqual(initial);
  const cancelled = AbortSignal.abort();
  await expect(backend.identity(cancelled)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(3);
});

it.each(['fingerprint', 'system_fingerprint'])('includes declared %s on success and rejection', async field => {
  const initial = await createJevDecision({ endpoint, fetch: server() }).identity();
  const options = { declared: { [field]: 'version-1' } };
  const backend = createJevDecision({ endpoint, fetch: server(options) });
  const first = await backend.identity();
  expect(first).not.toEqual(initial);
  options.declared[field] = 'version-2';
  expect(await createJevDecision({ endpoint, fetch: server(options) }).identity()).not.toEqual(first);
  expect(await createJevDecision({ endpoint, fetch: server({ declared: { [field]: 42 } }) }).identity()).toEqual(initial);
  const rejecting = server({ refuseLong: true });
  const withRejectionFingerprint: typeof fetch = async (url, init) => {
    const response = await rejecting(url, init);
    return response.status === 422 ? new Response(JSON.stringify(options.declared), { status: 422 }) : response;
  };
  expect(await createJevDecision({ endpoint, fetch: withRejectionFingerprint }).identity())
    .not.toEqual(await createJevDecision({ endpoint, fetch: server({ refuseLong: true }) }).identity());
});

it('records a rejected short canary when the long canary identifies the server', async () => {
  const normal = server();
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const { state } = JSON.parse(init!.body as string) as { state: string };
    return state === '{}' ? new Response('{}', { status: 422 }) : normal(url, init);
  };
  const identity = await createJevDecision({ endpoint, fetch }).identity();
  expect(identity).toMatchObject({ model: 'm', fingerprint: expect.any(String) });
  expect(identity).not.toEqual(await createJevDecision({ endpoint, fetch: server() }).identity());
});

it.each([500, 503])('throws long-canary HTTP %i and retries the entire probe afterward', async status => {
  const options = { status };
  const fetch = server(options);
  const backend = createJevDecision({ endpoint, fetch });
  await expect(backend.identity()).rejects.toThrow(`Decision HTTP ${status}`);
  options.status = 0;
  expect(await backend.identity()).toMatchObject({ fingerprint: expect.any(String) });
  expect(fetch).toHaveBeenCalledTimes(4);
});

it('throws a long-canary timeout and refuses invalid successful probability responses', async () => {
  const normal = server();
  const slow: typeof fetch = async (url, init) => {
    if (JSON.parse(init!.body as string).state.length < 30_000) return normal(url, init);
    return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(Error('timeout')), { once: true }));
  };
  await expect(createJevDecision({ endpoint, timeoutMs: 5, fetch: slow }).identity()).rejects.toThrow('timed out');
  for (const answers of [undefined, { paideia_identity: { probabilities: { true: 1 } } }]) {
    await expect(createJevDecision({ endpoint, fetch: async () => new Response(JSON.stringify({ model: 'm', answers })) }).identity())
      .rejects.toThrow('identity canary');
  }
});

it.each(['fingerprint', 'system_fingerprint'])('refuses changed, added or removed %s during scoring and final identity reads', async field => {
  for (const [before, after] of [['v1', 'v2'], [undefined, 'v2'], ['v1', undefined]]) {
    const options = { declared: { [field]: before } };
    const fetch = server(options);
    const backend = createJevDecision({ endpoint, fetch });
    await backend.identity();
    options.declared[field] = after;
    await expect(backend.score([request])).rejects.toThrow('fingerprint changed');
    await expect(backend.identity()).rejects.toThrow('fingerprint changed');
    await expect(backend.score([request])).rejects.toThrow('fingerprint changed');
    expect(fetch).toHaveBeenCalledTimes(3);
  }
});

it.each([false, true])('refuses revision drift on rejected scoring requests (rejected canary: %s)', async refuseLong => {
  let scoring = false;
  const normal = server({ refuseLong, declared: { fingerprint: 'v1' } });
  const fetch: typeof globalThis.fetch = async (url, init) => scoring
    ? new Response('{"fingerprint":"v2"}', { status: 422 }) : normal(url, init);
  const backend = createJevDecision({ endpoint, fetch });
  await backend.identity();
  scoring = true;
  await expect(backend.score([request])).rejects.toThrow('fingerprint changed');
  await expect(backend.identity()).rejects.toThrow('fingerprint changed');
});

it.each([{}, { fingerprint: 'v1' }])('allows rejected scoring requests without an observed revision change: %j', async declared => {
  let scoring = false;
  const normal = server({ declared: { fingerprint: 'v1' } });
  const fetch: typeof globalThis.fetch = async (url, init) => scoring
    ? new Response(JSON.stringify(declared), { status: 422 }) : normal(url, init);
  const backend = createJevDecision({ endpoint, fetch });
  const initial = await backend.identity();
  scoring = true;
  expect((await backend.score([request]))[0]?.status).toBe('missing');
  expect(await backend.identity()).toEqual(initial);
});

it.each(['second', undefined])('refuses final cached identity after scoring reports model %s', async model => {
  const options: { declared: Record<string, unknown> } = { declared: {} };
  const fetch = server(options);
  const backend = createJevDecision({ endpoint, fetch });
  await backend.identity();
  options.declared.model = model;
  await expect(backend.score([request])).rejects.toThrow(/model/);
  await expect(backend.identity()).rejects.toThrow(/model/);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('refuses revisions that differ between successful canaries', async () => {
  const normal = server();
  let count = 0;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const response = await normal(url, init);
    return new Response(JSON.stringify({ ...await response.json(), fingerprint: `v${++count}` }));
  };
  await expect(createJevDecision({ endpoint, fetch }).identity()).rejects.toThrow('fingerprint changed');
});
