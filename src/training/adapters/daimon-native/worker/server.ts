import type { DeliveryControls } from './deliveries.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { WorkerController } from './control.js';

export function createWorkerServer(controller: WorkerController, token: string): Server {
  const authenticated = (request: IncomingMessage): boolean => {
    const hash = (value: string) => createHash('sha256').update(value).digest();
    return timingSafeEqual(hash(request.headers.authorization ?? ''), hash(`Bearer ${token}`));
  };
  const server = createServer((request, response) => {
    void (async () => {
      if (!authenticated(request)) return reply(response, 401, { error: 'unauthorized' });
      const url = new URL(request.url ?? '/', 'http://worker.invalid');
      if (url.search || url.hash) return reply(response, 400, { error: 'unsupported_query' });
      if (request.method === 'GET' && url.pathname === '/trial/health') {
        return reply(response, 200, await controller.host.health());
      }
      if (request.method === 'GET' && url.pathname === '/v2/activity') {
        const value = await controller.host.activityV2(token);
        return reply(response, value ? 200 : 503, value ?? { error: 'native_host_unavailable' });
      }
      if (request.method === 'GET' && url.pathname === '/v2/availability') {
        const value = await controller.host.availability(token);
        return reply(response, value ? 200 : 503, value ?? { error: 'native_host_unavailable' });
      }
      const receipt = /^\/v2\/wake-receipts\/([0-9a-f-]{36})$/u.exec(url.pathname);
      if (request.method === 'GET' && receipt) {
        const value = await controller.host.wakeReceipt(token, receipt[1]!);
        return reply(response, value ? 200 : 404, value ?? { error: 'not_found' });
      }
      if (request.method === 'POST' && url.pathname === '/trial/stop') {
        return reply(response, 200, await controller.stop());
      }
      if (request.method === 'POST' && url.pathname === '/trial/run') {
        if (request.headers['content-type'] !== 'application/json') return reply(response, 400, { error: 'content_type_required' });
        const value = await body(request);
        if (Object.keys(value).some(key => !['text', 'wakeId', 'controls'].includes(key)) || value.controls !== undefined && (!value.controls || typeof value.controls !== 'object' || Array.isArray(value.controls)) || typeof value.wakeId !== 'string' || typeof value.text !== 'string') {
          return reply(response, 400, { error: 'invalid_trial_delivery' });
        }
        const abandoned = (): void => { if (!response.writableEnded) void controller.stop(); };
        response.once('close', abandoned);
        try { return reply(response, 200, await controller.run(value.wakeId, value.text, value.controls as DeliveryControls | undefined)); }
        finally { response.removeListener('close', abandoned); }
      }
      return reply(response, 404, { error: 'not_found' });
    })().catch(error => reply(response, 400, { error: error instanceof Error ? error.message : 'worker_request_failed' }));
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}

export function listenWorker(server: Server, bindHost: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bindHost, () => { server.removeListener('error', reject); resolve(); });
  });
}

function reply(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(value)}\n`);
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > 32_768) throw new Error('Worker request body exceeds its bound');
    chunks.push(bytes);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Worker request must be an object');
  return value as Record<string, unknown>;
}
