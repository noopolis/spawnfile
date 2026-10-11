import { afterEach, expect, it } from 'vitest';
import { createServer, type RequestListener, type Server } from 'node:http';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { createNativeHttpClient } from './http.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
  server.closeAllConnections(); server.close(() => resolve());
}))); });
async function endpoint(listener: RequestListener) {
  const server = createServer(listener); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
const token = 'unit-control-token-not-an-auth-login';

it('sends exact fixed paths, methods, JSON and authentication header only', async () => {
  const calls: unknown[] = [];
  const url = await endpoint(async (req, res) => {
    let body = ''; for await (const chunk of req) body += String(chunk);
    calls.push({ url: req.url, method: req.method, auth: req.headers.authorization, type: req.headers['content-type'], body });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end('{"ok":true}');
  });
  const request = createNativeHttpClient(url, token);
  expect(await request('/trial/health')).toEqual({ ok: true });
  await request('/trial/run', { wakeId: 'a', text: 'Evidence\nline' }); await request('/trial/stop', {});
  expect(calls).toEqual([
    { url: '/trial/health', method: 'GET', auth: `Bearer ${token}`, type: undefined, body: '' },
    { url: '/trial/run', method: 'POST', auth: `Bearer ${token}`, type: 'application/json', body: '{"wakeId":"a","text":"Evidence\\nline"}' },
    { url: '/trial/stop', method: 'POST', auth: `Bearer ${token}`, type: 'application/json', body: '{}' },
  ]);
});
it('rejects endpoint/path/auth/deadline/body changes before a request', async () => {
  let calls = 0;
  const url = await endpoint((_req, res) => { calls++; res.end(); });
  for (const bad of ['file:///tmp/socket', `${url}/other`, `${url}?secret=x`, `${url}#fragment`, url.replace('://', '://user:pass@')]) {
    expect(() => createNativeHttpClient(bad, token)).toThrow('endpoint');
  }
  for (const bad of ['', 'short', 'line\nbreak-is-unsafe', 'x'.repeat(4097)]) expect(() => createNativeHttpClient(url, bad)).toThrow('token');
  const request = createNativeHttpClient(url, token);
  await expect(request('/trial/health?leak' as '/trial/health')).rejects.toThrow('Unsupported');
  await expect(request('/trial/health', {})).rejects.toThrow('Unsupported');
  await expect(request('/trial/run')).rejects.toThrow('Unsupported');
  for (const ms of [0, 1.5, Infinity, 3608001]) await expect(request('/trial/health', undefined, ms)).rejects.toThrow('deadline');
  await expect(request('/trial/run', { text: 'x'.repeat(32769) })).rejects.toThrow('byte bound');
  await expect(request('/trial/health', undefined, 100, AbortSignal.abort())).rejects.toThrow();
  expect(calls).toBe(0);
});
it('admits an authenticated arm-status GET only when transport mode is selected', async () => {
  const calls: unknown[] = [];
  const url = await endpoint((req, res) => {
    calls.push({ method: req.method, path: req.url, auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"state":"idle"}');
  });
  expect(await createNativeHttpClient(url, token, 'transport')('/trial/run')).toEqual({ state: 'idle' });
  expect(calls).toEqual([{ method: 'GET', path: '/trial/run', auth: `Bearer ${token}` }]);
  await expect(createNativeHttpClient(url, token, 'transport')('/trial/stop')).rejects.toThrow('Unsupported');
});
it('does not forward tokens on redirects or expose server error payloads', async () => {
  let leaked = 0;
  const destination = await endpoint((_req, res) => { leaked++; res.end('{}'); });
  const redirect = await endpoint((_req, res) => { res.writeHead(302, { location: destination }); res.end(); });
  await expect(createNativeHttpClient(redirect, token)('/trial/health')).rejects.toThrow('transport failed');
  expect(leaked).toBe(0);
  const error = await endpoint((_req, res) => { res.writeHead(401); res.end(`secret ${token}`); });
  await expect(createNativeHttpClient(error, token)('/trial/health')).rejects.toThrow('HTTP status 401');
});
it.each(['invalid-json', 'wrong-type', 'invalid-utf8', 'too-large'])('rejects %s bounded responses', async mode => {
  const url = await endpoint((_req, res) => {
    res.writeHead(200, { 'content-type': mode === 'wrong-type' ? 'application/json-malformed' : 'application/json' });
    res.end(mode === 'invalid-utf8' ? Buffer.from([0xff]) : mode === 'too-large' ? 'x'.repeat(16777217) : 'not-json');
  });
  await expect(createNativeHttpClient(url, token)('/trial/health')).rejects.toThrow(/JSON|malformed|bound/);
});
it('enforces deadlines and cancellation while waiting for headers or response body', async () => {
  const url = await endpoint((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders(); res.write('{'); });
  const request = createNativeHttpClient(url, token);
  await expect(request('/trial/health', undefined, 20)).rejects.toThrow('expired');
  const controller = new AbortController(); const pending = request('/trial/health', undefined, 2000, controller.signal);
  controller.abort(); await expect(pending).rejects.toThrow(/cancelled|abort/i);
  const stalled = await endpoint(() => undefined);
  await expect(createNativeHttpClient(stalled, token)('/trial/health', undefined, 20)).rejects.toThrow('expired');
});
it('lets a slow worker answer past the ambient header timeout instead of failing the transport', async () => {
  const previous = getGlobalDispatcher();
  const ambient = new Agent({ headersTimeout: 200, bodyTimeout: 200 });
  setGlobalDispatcher(ambient);
  try {
    const url = await endpoint((_req, res) => setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"late":true}');
    }, 1600).unref());
    expect(await createNativeHttpClient(url, token)('/trial/run', { wakeId: 'slow' }, 20_000)).toEqual({ late: true });
  } finally { setGlobalDispatcher(previous); await ambient.close(); }
});
it('still reports a transport failure when the worker dies mid-request', async () => {
  const url = await endpoint((req, res) => { void req; res.socket?.destroy(); });
  await expect(createNativeHttpClient(url, token)('/trial/run', { wakeId: 'dies' }, 20_000)).rejects.toThrow('transport failed');
});
it('reports an over-deadline worker as expired rather than as a transport failure', async () => {
  const url = await endpoint(() => undefined);
  const failure = await createNativeHttpClient(url, token)('/trial/run', { wakeId: 'hangs' }, 2000).catch((error: Error) => error.message);
  expect(failure).toBe('Native worker request cancelled or expired');
});
