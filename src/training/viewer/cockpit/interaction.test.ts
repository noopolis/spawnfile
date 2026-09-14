import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { cockpitScript } from './interaction.js';

afterEach(()=>vi.useRealTimers());
function element(dataset:Record<string,string>={},id='') {
  const listeners=new Map<string,()=>void>();const attributes=new Map<string,string>();const classes=new Set<string>();
  return {dataset,id,attributes,classes,hidden:false,value:'0',checked:false,open:false,scrollTop:0,textContent:'',
    ancestor:undefined as {dataset:Record<string,string>}|undefined,
    closest(_selector:string){return this.ancestor;},
    classList:{toggle:(name:string,enabled:boolean)=>enabled?classes.add(name):classes.delete(name)},
    addEventListener:(name:string,callback:()=>void)=>listeners.set(name,callback),
    setAttribute:(name:string,value:string)=>attributes.set(name,value),
    fire:(name:string)=>listeners.get(name)!(),focus:vi.fn(),scrollIntoView:vi.fn()};
}
function shell(live:boolean) {
  const buttons=['overview','trials','costs','provenance'].map(view=>element({viewButton:view}));
  const panes=['overview','trials','costs','provenance'].map(view=>Object.assign(element({viewPane:view}),{
    details:[element(),element()],querySelectorAll(_selector:string){return this.details;},
  }));
  const selects=[element(),element()];const metrics=[element({metricPanel:'0'}),element({metricPanel:'1'})];
  const open=element({openTrial:'0'}),drawer=panes[1]!.details[0]!,refresh=element({},'refresh'),poll=element({},'poll');
  drawer.id='trial-0';poll.checked=live;
  drawer.dataset.trialKey='stable-trial';for(const node of panes[1]!.details)node.ancestor=drawer;
  const label=element({},'stream-state'),sidebar=element();
  return {buttons,panes,selects,metrics,open,drawer,refresh,poll,label,sidebar,
    querySelectorAll:(selector:string)=>new Map([
      ['[data-view-button]',buttons],['[data-view-pane]',panes],['[data-metric-select]',selects],
      ['[data-metric-panel]',metrics],['[data-open-trial]',[open]],['[data-view-pane], .sidebar',[...panes,sidebar]],
    ]).get(selector),
    getElementById:(id:string)=>new Map([['trial-0',drawer],['refresh',refresh],['poll',poll],['stream-state',label]]).get(id),
  };
}
function fixture(hash='',live=false) {
  let current=shell(live),fragment=hash;
  const location={get hash(){return fragment;},set hash(value:string){fragment=value.startsWith('#')?value:`#${value}`;},pathname:'/',search:''};
  const documentEvents=new Map<string,()=>void>(),windowEvents=new Map<string,()=>void>();
  const document={visibilityState:'visible',activeElement:undefined as ReturnType<typeof element>|undefined,
    querySelectorAll:(selector:string)=>current.querySelectorAll(selector),getElementById:(id:string)=>current.getElementById(id),
    querySelector:()=>({replaceWith:(next:ReturnType<typeof shell>)=>{current=next;}}),
    addEventListener:(name:string,callback:()=>void)=>documentEvents.set(name,callback)};
  const connections:Array<{path:string;readyState:number;close:ReturnType<typeof vi.fn>;fire:(event:string)=>void}>=[];
  class EventSource {
    readyState=0;listeners=new Map<string,()=>void>();close=vi.fn(()=>{this.readyState=2;});
    constructor(public path:string){connections.push(this);}
    addEventListener(name:string,callback:()=>void){this.listeners.set(name,callback);}
    fire(event:string){if(event==='open')this.readyState=1;this.listeners.get(event)!();}
  }
  const fetch=vi.fn(async (_path:string,_options:{cache:string;signal:AbortSignal})=>({ok:true,text:async()=>'<html>'}));
  const parse=vi.fn(()=>({querySelector:()=>shell(true) as ReturnType<typeof shell>|null}));
  class DOMParser {parseFromString(){return parse();}}
  runInNewContext(cockpitScript,{document,location,EventSource,DOMParser,fetch,AbortController,setTimeout,clearTimeout,
    window:{addEventListener:(name:string,callback:()=>void)=>windowEvents.set(name,callback)}});
  return {get shell(){return current;},location,document,connections,fetch,parse,
    visibility:()=>documentEvents.get('visibilitychange')!(),unload:()=>windowEvents.get('beforeunload')!()};
}
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

describe('shipped read-only streaming cockpit controller',()=>{
  it('restores navigation/metric and trial controls before and after shell replacement',async()=>{
    const f=fixture('#costs/1');
    expect(f.shell.buttons[2]!.attributes.get('aria-pressed')).toBe('true');
    expect(f.shell.panes.map(pane=>pane.hidden)).toEqual([true,true,false,true]);
    f.shell.buttons[0]!.fire('click');expect(f.location.hash).toBe('#overview/1');
    f.shell.selects[0]!.value='0';f.shell.selects[0]!.fire('change');expect(f.location.search).toBe('?metric=0');
    const old=f.shell;f.shell.refresh.fire('click');await settle();expect(f.shell).not.toBe(old);
    f.shell.open.fire('click');expect(f.location.hash).toBe('#trials/1');expect(f.shell.drawer.open).toBe(true);
    expect(f.shell.drawer.focus).toHaveBeenCalledOnce();expect(f.shell.drawer.scrollIntoView).toHaveBeenCalledWith({block:'nearest'});
    expect(f.fetch.mock.calls[0]![0]).toBe('/?metric=0');expect(f.fetch.mock.calls[0]![1].cache).toBe('no-store');
    expect(fixture('#untrusted/999').location.hash).toBe('#overview/0');
  });
  it('streams revisions through read-only requests and does not poll while paused/hidden',async()=>{
    const f=fixture('',true);expect(f.connections[0]!.path).toBe('/api/events');
    f.connections[0]!.fire('open');expect(f.shell.label.textContent).toBe('Streaming');
    f.document.visibilityState='hidden';f.connections[0]!.fire('snapshot');expect(f.fetch).not.toHaveBeenCalled();
    f.document.visibilityState='visible';f.visibility();await settle();expect(f.fetch).toHaveBeenCalledOnce();
    f.connections[0]!.fire('snapshot');await settle();expect(f.fetch).toHaveBeenCalledTimes(2);
    f.shell.poll.checked=false;f.shell.poll.fire('change');
    for(const event of ['open','snapshot','unavailable','error'])f.connections[0]!.fire(event);
    expect(f.shell.label.textContent).toBe('Paused');expect(f.fetch).toHaveBeenCalledTimes(2);
    f.visibility();expect(f.fetch).toHaveBeenCalledTimes(2);expect(cockpitScript).not.toMatch(/POST|localStorage|sendBeacon|__name/);
  });
  it('preserves the latest pause, drawer, scroll and focus changes made while a refresh is in flight',async()=>{
    const f=fixture('#trials/0',true);f.connections[0]!.fire('open');
    let finish!:(value:{ok:boolean;text:()=>Promise<string>})=>void;
    f.fetch.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));f.connections[0]!.fire('snapshot');
    f.shell.poll.checked=false;f.shell.poll.fire('change');
    f.shell.panes[1]!.details[1]!.open=true;f.shell.panes[1]!.scrollTop=123;f.shell.sidebar.scrollTop=52;
    f.document.activeElement=f.shell.refresh;finish({ok:true,text:async()=>'<html>'});await settle();
    expect(f.shell.poll.checked).toBe(false);expect(f.shell.label.textContent).toBe('Paused');
    expect(f.shell.panes[1]!.details[1]!.open).toBe(true);expect(f.shell.panes[1]!.scrollTop).toBe(123);expect(f.shell.sidebar.scrollTop).toBe(52);
    expect(f.shell.refresh.focus).toHaveBeenCalledWith({preventScroll:true});expect(f.connections).toHaveLength(1);
  });
  it('coalesces concurrent revisions to one queued refresh, never overlapping fetches',async()=>{
    const f=fixture('',true);let finish!:(value:{ok:boolean;text:()=>Promise<string>})=>void;
    f.fetch.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    f.connections[0]!.fire('snapshot');f.connections[0]!.fire('snapshot');f.shell.refresh.fire('click');
    expect(f.fetch).toHaveBeenCalledOnce();finish({ok:true,text:async()=>'<html>'});await settle();expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it('keeps open drawers attached to stable trial identities when new trials arrive earlier',async()=>{
    const f=fixture('#trials/0');f.shell.drawer.open=true;f.shell.panes[1]!.details[1]!.open=true;
    const next=shell(false);const inserted=element({trialKey:'different-trial'});inserted.ancestor=inserted;
    next.panes[1]!.details.unshift(inserted);f.parse.mockReturnValueOnce({querySelector:()=>next});
    f.shell.refresh.fire('click');await settle();
    expect(f.shell.panes[1]!.details.map(node=>node.open)).toEqual([false,true,true]);
  });
  it('displays errors, reconnects via EventSource, and bounds a stalled HTML fetch',async()=>{
    vi.useFakeTimers();const f=fixture('',true);
    f.connections[0]!.fire('unavailable');expect(f.shell.label.textContent).toBe('Snapshot unavailable');
    f.connections[0]!.fire('error');expect(f.shell.label.textContent).toBe('Disconnected · reconnecting');
    f.connections[0]!.fire('open');expect(f.shell.label.textContent).toBe('Streaming');
    f.fetch.mockResolvedValueOnce({ok:false,text:async()=>''});f.shell.refresh.fire('click');await settle();expect(f.shell.label.textContent).toBe('Snapshot unavailable');
    f.parse.mockReturnValueOnce({querySelector:()=>null});f.shell.refresh.fire('click');await settle();expect(f.shell.label.textContent).toBe('Snapshot unavailable');
    f.fetch.mockImplementationOnce((_path,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted')))));
    f.shell.refresh.fire('click');await vi.advanceTimersByTimeAsync(10000);
    expect(f.fetch.mock.calls.at(-1)![1].signal.aborted).toBe(true);expect(f.shell.label.textContent).toBe('Snapshot unavailable');
    f.shell.refresh.fire('click');await settle();expect(f.shell.label.textContent).toBe('Streaming');
  });
  it('aborts pending refreshes on unload and ignores queued events from obsolete streams',async()=>{
    const f=fixture('',true);f.shell.poll.fire('change');expect(f.connections[0]!.close).toHaveBeenCalledOnce();
    f.connections[0]!.fire('error');expect(f.shell.label.textContent).toBe('Connecting');
    let finish!:(value:{ok:boolean;text:()=>Promise<string>})=>void;
    f.fetch.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));f.connections[1]!.fire('snapshot');
    f.connections[1]!.fire('snapshot');const original=f.shell;f.unload();finish({ok:true,text:async()=>'<html>'});await settle();
    expect(f.shell).toBe(original);expect(f.fetch).toHaveBeenCalledOnce();expect(f.connections[1]!.close).toHaveBeenCalledOnce();
    expect(f.fetch.mock.calls[0]![1].signal.aborted).toBe(true);f.connections[1]!.fire('snapshot');expect(f.fetch).toHaveBeenCalledOnce();
  });
});
