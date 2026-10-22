import { fetch, getGlobalDispatcher } from 'undici';
import type { NativeWorkerRequest } from './types.js';

const responseLimit = 16_777_216;
/**
 * A worker holding a socket open is working, not broken: the request's own
 * deadline is the only authority on how long that may last. undici's ambient
 * header and body timeouts (300 seconds by default) are shorter than a
 * legitimate trial turn and would tear down a healthy worker as a transport
 * failure, so every request carries its own, derived from that deadline and
 * deliberately later than it. An over-deadline worker then expires through the
 * abort signal and is reported as cancelled or expired, while a dead socket
 * still surfaces as a transport failure. undici's timers are accurate to within
 * 500ms, well inside this grace.
 */
const dispatcherGraceMs = 30_000;
/** Fixed caller-authorized endpoint. No ambient credentials, URL credentials or redirects. */
export function createNativeHttpClient(endpoint: string, token: string, delivery: 'direct' | 'transport' = 'direct'): NativeWorkerRequest {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Native worker endpoint must be an HTTP origin without credentials, path or query');
  }
  if (!/^[\x21-\x7e]{16,4096}$/u.test(token)) throw new Error('Native worker authentication token is invalid');
  return async <T>(path: string, body?: unknown, timeoutMs = 5000, signal?: AbortSignal): Promise<T> => {
    if (!['/trial/health', '/trial/run', '/trial/stop', '/v2/activity'].includes(path) ||
        (['/trial/health', '/v2/activity'].includes(path) ? body !== undefined
          : body === undefined && !(path === '/trial/run' && delivery === 'transport'))) throw new Error('Unsupported native worker request');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_408_000) throw new Error('Invalid native worker request deadline');
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined && Buffer.byteLength(payload) > 32768) throw new Error('Native worker request exceeds its byte bound');
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    combined.throwIfAborted();
    // Composing the process dispatcher binds both timeouts per request without owning a connection pool to close or leak.
    const bound = timeoutMs + dispatcherGraceMs;
    const dispatcher = getGlobalDispatcher().compose(dispatch => (options, handler) =>
      dispatch({ ...options, headersTimeout: bound, bodyTimeout: bound }, handler));
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(new URL(path, url), { method: payload === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
        body: payload, signal: combined, dispatcher });
    } catch { throw new Error(combined.aborted ? 'Native worker request cancelled or expired' : 'Native worker transport failed'); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Native worker HTTP status ${response.status}`); }
    if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json' || !response.body) {
      await response.body?.cancel(); throw new Error('Native worker response is not JSON');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        if (bytes > responseLimit) throw new Error('Native worker response exceeds its byte bound');
        chunks.push(next.value);
      }
      combined.throwIfAborted();
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as T;
    } catch {
      await reader.cancel().catch(() => undefined);
      throw new Error(combined.aborted ? 'Native worker response cancelled or expired' : 'Native worker response is malformed or exceeds its bound');
    } finally { reader.releaseLock(); }
  };
}
