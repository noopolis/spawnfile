import { afterEach, expect, it, vi } from 'vitest';
import { startViewer } from './server.js';
import { viewerFixture } from './fixture.js';
import type { ViewerServer } from './types.js';

const servers:ViewerServer[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).map(server=>server.close()));});
it('streams real HTTP revisions of sanitized snapshots and releases the loader after disconnect',async()=>{
  const data=viewerFixture();const load=vi.fn(async()=>({...data,privateCapture:'SECRET'}));
  const server=await startViewer({load});servers.push(server);
  const controller=new AbortController();
  const response=await fetch(`${server.url}/api/events`,{signal:controller.signal});
  expect(response.status).toBe(200);expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader=response.body!.getReader();
  const first=new TextDecoder().decode((await reader.read()).value);
  expect(first).toMatch(/event: snapshot\ndata: \{"revision":"[a-f0-9]{64}"\}/);expect(first).not.toContain('SECRET');
  const heartbeat=new TextDecoder().decode((await reader.read()).value);expect(heartbeat).toBe(': heartbeat\n\n');
  data.experiment.status='completed';
  const changed=new TextDecoder().decode((await reader.read()).value);expect(changed).toContain('event: snapshot');expect(changed).not.toBe(first);
  await reader.cancel();controller.abort();await new Promise(resolve=>setTimeout(resolve,20));
  const count=load.mock.calls.length;await new Promise(resolve=>setTimeout(resolve,1100));
  expect(load).toHaveBeenCalledTimes(count);
});
it('enforces finite stream capacity and reclaims disconnected client slots',async()=>{
  const server=await startViewer({load:async()=>viewerFixture()});servers.push(server);
  const responses=await Promise.all(Array.from({length:16},()=>fetch(`${server.url}/api/events`)));
  expect(responses.every(response=>response.status===200)).toBe(true);
  const rejected=await fetch(`${server.url}/api/events`);expect(rejected.status).toBe(503);
  expect(await rejected.text()).toBe('Stream capacity reached.');
  await responses[0]!.body!.cancel();
  let replacement:Response|undefined;
  await vi.waitFor(async()=>{replacement=await fetch(`${server.url}/api/events`);expect(replacement.status).toBe(200);});
  await Promise.all([...responses.slice(1),replacement!].map(response=>response.body!.cancel()));
});
it('sends generic load errors and shuts down even with a pending stream load',async()=>{
  let pending=false;
  const server=await startViewer({load:()=>pending?new Promise(()=>undefined):Promise.reject(new Error('SECRET path'))});servers.push(server);
  const response=await fetch(`${server.url}/api/events`);const reader=response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('event: unavailable\ndata: {}\n\n');
  await reader.cancel();pending=true;
  const waiting=await fetch(`${server.url}/api/events`);const hanging=waiting.body!.getReader().read().catch(()=>undefined);
  await server.close();expect(await hanging).toBeUndefined();
});
