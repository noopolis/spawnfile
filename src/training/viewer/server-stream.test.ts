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
  await server.close();expect(new TextDecoder().decode((await hanging)!.value)).toBe('event: final\ndata: {"html":null}\n\n');
});

it.each(['failed','completed'])('delivers the final %s snapshot before closing without another GET',async status=>{
  const data=viewerFixture(),load=vi.fn(async()=>data);
  const server=await startViewer({load});servers.push(server);
  const response=await fetch(`${server.url}/api/events?metric=1`),reader=response.body!.getReader();
  await reader.read();
  data.experiment.status=status;data.experiment.title='<img src=x onerror=alert(1)>';
  data.costs={observed:{total:{low:12.34,high:12.34},knownSubtotal:{low:12.34,high:12.34},
    completeness:'complete',usageCoverage:'observed-only',groups:[],lines:[]}};
  const finished=(async()=>{let text='';while(true){const next=await reader.read();if(next.done)return text;text+=new TextDecoder().decode(next.value);}})();
  await server.close({...data,privateCapture:'SECRET'} as typeof data);
  const text=await finished,match=/event: final\ndata: (.+)\n\n/.exec(text);
  expect(match).not.toBeNull();const {html}=JSON.parse(match![1]!);
  expect(html).toContain(status==='failed'?'Run stopped':'>completed<');
  expect(html).toContain('$12.34');expect(html).toContain('data-metric-panel="1"');expect(html).toContain('1 trials');
  expect(html).toContain('&lt;img');expect(html).not.toMatch(/<img|SECRET/);
  expect(load).toHaveBeenCalledOnce();await expect(fetch(server.url)).rejects.toThrow();
});
it('ends with no private payload when given an invalid final projection',async()=>{
  const server=await startViewer({load:()=>new Promise(()=>undefined)});servers.push(server);
  const response=await fetch(`${server.url}/api/events`);const reading=response.text();
  await server.close({...viewerFixture(),schema:'PRIVATE'} as never);
  expect(await reading).toBe('event: final\ndata: {"html":null}\n\n');
});
