import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { streamSnapshots } from './stream.js';
import { viewerFixture } from './fixture.js';

afterEach(()=>vi.useRealTimers());
function fixture() {
  vi.useFakeTimers();
  const response=Object.assign(new EventEmitter(),{writableEnded:false,destroyed:false,
    writeHead:vi.fn(),flushHeaders:vi.fn(),write:vi.fn((_text:string)=>true),end:vi.fn((_text:string)=>undefined),destroy:vi.fn()});
  response.end.mockImplementation(()=>{response.writableEnded=true;response.emit('close');});
  response.destroy.mockImplementation(()=>{response.destroyed=true;response.emit('close');});
  const load=vi.fn(async()=>viewerFixture()); const closed=vi.fn();
  const start=()=>streamSnapshots(response as unknown as ServerResponse,load,closed);
  return {response,load,closed,start};
}
it('streams only projected revisions, heartbeats unchanged snapshots, and signals generic errors before recovering',async()=>{
  const f=fixture(); const data=viewerFixture();
  f.load.mockResolvedValue({...data,rawSecret:'PRIVATE PROMPT'} as typeof data); f.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.response.writeHead).toHaveBeenCalledWith(200,expect.objectContaining({'Content-Type':'text/event-stream; charset=utf-8'}));
  const first=f.response.write.mock.calls[0]![0] as unknown as string;
  expect(first).toMatch(/^event: snapshot\ndata: \{"revision":"[a-f0-9]{64}"\}\n\n$/);
  expect(first).not.toContain('PRIVATE');
  f.load.mockResolvedValue(data); await vi.advanceTimersByTimeAsync(1000);
  expect(f.response.write).toHaveBeenLastCalledWith(': heartbeat\n\n');
  f.load.mockRejectedValueOnce(new Error('SECRET loader failure')); await vi.advanceTimersByTimeAsync(1000);
  expect(f.response.write).toHaveBeenLastCalledWith('event: unavailable\ndata: {}\n\n');
  f.load.mockResolvedValue({...data,experiment:{...data.experiment,status:'completed'}});
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.response.write.mock.calls.at(-1)![0]).not.toBe(first);
  f.response.destroy(); await vi.advanceTimersByTimeAsync(5000);
  expect(f.load).toHaveBeenCalledTimes(4); expect(f.closed).toHaveBeenCalledOnce();
});
it.each(['snapshot','heartbeat','unavailable'])('disconnects a slow reader rather than buffering %s frames',async kind=>{
  const f=fixture();
  if(kind==='heartbeat') {f.start();await vi.advanceTimersByTimeAsync(0);}
  if(kind==='unavailable')f.load.mockRejectedValue(new Error('PRIVATE'));
  f.response.write.mockReturnValue(false);
  if(kind!=='heartbeat')f.start();
  await vi.advanceTimersByTimeAsync(kind==='heartbeat'?1000:0);
  expect(f.response.destroy).toHaveBeenCalledOnce(); expect(f.closed).toHaveBeenCalledOnce();
  const count=f.load.mock.calls.length;await vi.advanceTimersByTimeAsync(5000);expect(f.load).toHaveBeenCalledTimes(count);
});
it('does not overlap loaders or write after a disconnected pending load',async()=>{
  const f=fixture(); let resolve!: (data:ReturnType<typeof viewerFixture>)=>void;
  f.load.mockImplementation(()=>new Promise(done=>{resolve=done;}));f.start();
  await vi.advanceTimersByTimeAsync(5000);expect(f.load).toHaveBeenCalledOnce();
  f.response.destroy();resolve(viewerFixture());await vi.advanceTimersByTimeAsync(5000);
  expect(f.response.write).not.toHaveBeenCalled();expect(f.closed).toHaveBeenCalledOnce();
});
it('handles write exceptions and response errors without leaking diagnostics or leaving timers',async()=>{
  const f=fixture(); f.response.write.mockImplementation(()=>{throw new Error('PRIVATE write detail');});f.start();
  await vi.advanceTimersByTimeAsync(0);expect(f.response.destroy).toHaveBeenCalledOnce();
  const second=fixture();second.start();second.response.emit('error',new Error('socket gone'));
  await vi.advanceTimersByTimeAsync(5000);expect(second.closed).toHaveBeenCalledOnce();expect(second.load).toHaveBeenCalledOnce();
});
it('stops polling immediately when destruction precedes the asynchronous close event',async()=>{
  const f=fixture();f.response.destroy.mockImplementation(()=>{f.response.destroyed=true;});
  f.response.write.mockReturnValue(false);f.start();await vi.advanceTimersByTimeAsync(5000);
  expect(f.load).toHaveBeenCalledOnce();expect(f.closed).not.toHaveBeenCalled();
  f.response.emit('close');expect(f.closed).toHaveBeenCalledOnce();
});
it('does not invoke an already-queued poll after destruction but before close notification',async()=>{
  const f=fixture();f.start();await vi.advanceTimersByTimeAsync(0);
  f.response.destroyed=true;await vi.advanceTimersByTimeAsync(5000);
  expect(f.load).toHaveBeenCalledOnce();f.response.emit('close');expect(f.closed).toHaveBeenCalledOnce();
});

it('ends with the supplied final shell even while a previous snapshot load is pending',async()=>{
  const f=fixture();let resolve!:(data:ReturnType<typeof viewerFixture>)=>void;
  f.load.mockImplementation(()=>new Promise(done=>{resolve=done;}));const stream=f.start();
  const closing=stream.close('<div class="shell">final</div>');expect(stream.close('ignored')).toBe(closing);await closing;
  expect(f.response.end).toHaveBeenCalledWith('event: final\ndata: {"html":"<div class=\\"shell\\">final</div>"}\n\n');
  resolve(viewerFixture());await vi.advanceTimersByTimeAsync(5000);
  expect(f.response.write).not.toHaveBeenCalled();expect(f.load).toHaveBeenCalledOnce();expect(f.closed).toHaveBeenCalledOnce();
});
it('bounds final response closure for an unresponsive reader without a grace sleep',async()=>{
  const f=fixture();const stream=f.start();await vi.advanceTimersByTimeAsync(0);
  f.response.end.mockImplementation(()=>{f.response.writableEnded=true;});
  let finished=false;const closing=stream.close('final').then(()=>{finished=true;});
  await vi.advanceTimersByTimeAsync(999);expect(finished).toBe(false);expect(f.response.destroy).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);await closing;expect(f.response.destroy).toHaveBeenCalledOnce();expect(f.closed).toHaveBeenCalledOnce();
});
it('settles already disconnected streams and destroys failed terminal writes',async()=>{
  const f=fixture(),stream=f.start();f.response.destroy();await stream.close();expect(f.response.end).not.toHaveBeenCalled();
  const second=fixture(),other=second.start();second.response.end.mockImplementation(()=>{throw new Error('PRIVATE');});
  await other.close();expect(second.response.destroy).toHaveBeenCalledOnce();
});
