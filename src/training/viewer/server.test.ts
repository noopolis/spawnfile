import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'node:http';
import { viewerFixture } from './fixture.js';
import { startViewer, type ViewerData, type ViewerServer } from './index.js';

const servers: ViewerServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });

describe('actual local viewer HTTP server', () => {
  it('serves escaped HTML and fresh JSON from only the supplied read-only loader', async () => {
    const data = viewerFixture();
    data.experiment.title = '<img src=x onerror=alert(1)>';
    const load = vi.fn(async () => ({ ...data, rawSealed: 'SECRET' }));
    const server = await startViewer({ load }); servers.push(server);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
    const response = await fetch(server.url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('cache-control')).toBe('no-store');
    const html = await response.text();
    expect(html).toContain('&lt;img'); expect(html).not.toContain('<img');
    expect(html).not.toContain('SECRET');
    data.experiment.status = 'completed';
    const api = await fetch(`${server.url}/api/data`);
    expect(api.headers.get('content-type')).toContain('application/json');
    expect(await api.json()).toEqual(data);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('rejects write methods, unknown paths and rebinding hosts before reading any data', async () => {
    const load = vi.fn(async () => viewerFixture());
    const server = await startViewer({ load, port: 0 }); servers.push(server);
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
      const response = await fetch(server.url, { method });
      expect(response.status).toBe(405); expect(response.headers.get('allow')).toBe('GET');
    }
    expect((await fetch(`${server.url}/unknown`)).status).toBe(404);
    for (const path of ['/?metric=-1', '/?metric=10000', '/?metric=1&extra=2', '/?metric=Infinity']) {
      expect((await fetch(`${server.url}${path}`)).status).toBe(404);
    }
    const status = await new Promise<number | undefined>((resolve, reject) => {
      get(server.url, { headers: { Host: 'attacker.invalid' } }, (response) => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    expect(status).toBe(403);
    expect(load).not.toHaveBeenCalled();
  });

  it('selects one chart with a bounded read-only query instead of duplicating all overview panels', async () => {
    const load = vi.fn(async () => viewerFixture());
    const server = await startViewer({ load }); servers.push(server);
    const response = await fetch(`${server.url}/?metric=1`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-metric-panel="1"');
    expect(html.match(/data-metric-panel="\d+"/g)).toHaveLength(1);
    expect(html).toContain('<option value="1" selected>');
    expect(load).toHaveBeenCalledOnce();
    const fallback = await fetch(`${server.url}/?metric=9999`).then(value => value.text());
    expect(fallback).toContain('data-metric-panel="0"');
  });

  it('discloses neither loader exception details nor invalid private data, and can recover', async () => {
    const load = vi.fn<() => Promise<ViewerData>>(async () => { throw new Error('private /path and SECRET prompt'); });
    const server = await startViewer({ load }); servers.push(server);
    const error = await fetch(server.url);
    expect(error.status).toBe(503); expect(await error.text()).toBe('Snapshot unavailable. Refresh to retry.');
    load.mockImplementation(async () => ({ ...viewerFixture(), schema: 'wrong' }) as unknown as ViewerData);
    expect((await fetch(`${server.url}/api/data`)).status).toBe(503);
    load.mockImplementation(async () => viewerFixture());
    expect((await fetch(server.url)).status).toBe(200);
  });

  it('closes idempotently and propagates binding failures and invalid ports', async () => {
    const server = await startViewer({ load: async () => viewerFixture() }); servers.push(server);
    await expect(startViewer({ load: async () => viewerFixture(), port: server.port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    for (const port of [-1, 65536, 1.5]) await expect(startViewer({ load: async () => viewerFixture(), port })).rejects.toThrow('0–65535');
    const closing = server.close(); expect(server.close()).toBe(closing); await closing;
    await expect(fetch(server.url)).rejects.toThrow();
  });

  it('closes open connections even if the caller loader never resolves', async () => {
    let entered!: () => void;
    const loading = new Promise<void>((resolve) => { entered = resolve; });
    const server = await startViewer({ load: () => { entered(); return new Promise(() => undefined); } }); servers.push(server);
    const pending = fetch(server.url).catch(() => undefined);
    await loading; await server.close(); expect(await pending).toBeUndefined();
  });
});
