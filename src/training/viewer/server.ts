import { randomBytes } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { renderViewer } from './page.js';
import { projectViewerData } from './projection.js';
import type { ViewerOptions, ViewerServer } from './types.js';
import { streamSnapshots } from './stream.js';

function respond(response: ServerResponse, status: number, text: string, type: string): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin' });
  response.end(text);
}

/** Loopback-only presentation. The loader is the sole data source and must be read-only. */
export async function startViewer(options: ViewerOptions): Promise<ViewerServer> {
  const requestedPort = options.port ?? 0;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('Viewer port must be 0–65535');
  let port = 0;
  let streams = 0;
  const server = createServer(async (request, response) => {
    if (request.headers.host !== `127.0.0.1:${port}`) return respond(response, 403, 'Invalid local host.', 'text/plain');
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      return respond(response, 405, 'Read-only viewer: GET required.', 'text/plain');
    }
    const metric = /^\/\?metric=(\d{1,4})$/.exec(request.url ?? '');
    if (request.url === '/api/events') {
      if (streams >= 16) return respond(response, 503, 'Stream capacity reached.', 'text/plain');
      streams++;
      streamSnapshots(response, options.load, () => { streams--; });
      return;
    }
    if (request.url !== '/' && request.url !== '/api/data' && !metric) return respond(response, 404, 'Not found.', 'text/plain');
    try {
      const data = projectViewerData(await options.load());
      if (response.destroyed || response.writableEnded) return;
      if (request.url === '/api/data') return respond(response, 200, JSON.stringify(data), 'application/json');
      const nonce = randomBytes(18).toString('hex');
      response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
      return respond(response, 200, renderViewer(data, nonce, metric ? Number(metric[1]) : 0), 'text/html');
    } catch {
      // Loader errors may contain private paths or prompt text. Never serialize them.
      return respond(response, 503, 'Snapshot unavailable. Refresh to retry.', 'text/plain');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  // listen completed on an explicit TCP host, so the address is an AddressInfo.
  port = (server.address() as AddressInfo).port;
  let closing: Promise<void> | undefined;
  return { url: `http://127.0.0.1:${port}`, port, close: () => {
    closing ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closing;
  } };
}
