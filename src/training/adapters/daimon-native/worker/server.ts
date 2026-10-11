import type { DeliveryControls } from './deliveries.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { WorkerController } from './control.js';
import { parseTransportSource, TransportAdmissionClosedError } from './wake-delivery/index.js';

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
      if (controller.transport && request.method === 'GET' && url.pathname === '/trial/run') {
        return reply(response, 200, controller.transport.state());
      }
      if (controller.transport && request.method === 'POST' && url.pathname === '/v2/wakes') {
        if (request.headers['content-type'] !== 'application/json') return reply(response, 400, { error: 'content-type must be application/json' });
        const value = await body(request, 1_048_576, { bound: 'request body is too large', object: 'request body must be an object' });
        // Daimon's host owns schema rejection and its structured acceptance body.
        const result = await controller.transport.accept({ ...value, token });
        const status = result.state === 'accepted' ? 202 : result.state === 'stopped' ? 409
          : result.code === 'invalid_request' ? 400 : result.code === 'unauthorized' ? 401 : 409;
        return reply(response, status, result);
      }
      if (request.method === 'POST' && url.pathname === '/trial/run') {
        if (request.headers['content-type'] !== 'application/json') return reply(response, 400, { error: 'content_type_required' });
        const value = await body(request);
        const fields = controller.transport ? ['text', 'wakeId', 'controls', 'source'] : ['text', 'wakeId', 'controls'];
        if (Object.keys(value).some(key => !fields.includes(key)) || value.controls !== undefined && (!value.controls || typeof value.controls !== 'object' || Array.isArray(value.controls)) || typeof value.wakeId !== 'string' ||
            !(controller.transport && value.text === undefined) && typeof value.text !== 'string') {
          return reply(response, 400, { error: 'invalid_trial_delivery' });
        }
        const source = controller.transport ? parseTransportSource(value.source) : undefined;
        const abandoned = (): void => { if (!response.writableEnded) void controller.stop(); };
        response.once('close', abandoned);
        try { return reply(response, 200, await controller.run(value.wakeId, value.text as string ?? '', value.controls as DeliveryControls | undefined, source)); }
        finally { response.removeListener('close', abandoned); }
      }
      return reply(response, 404, { error: 'not_found' });
    })().catch(error => reply(response, error instanceof TransportAdmissionClosedError ? 409 : 400,
      { error: error instanceof Error ? error.message : 'worker_request_failed' }));
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

async function body(request: IncomingMessage, maximum = 32_768,
  errors = { bound: 'Worker request body exceeds its bound', object: 'Worker request must be an object' }): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > maximum) throw new Error(errors.bound);
    chunks.push(bytes);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(errors.object);
  return value as Record<string, unknown>;
}
