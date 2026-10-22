import { createServer } from 'node:net';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { launchFixture } from '../test-fixtures.js';
import { sha256 } from '../receipt/index.js';

/**
 * Real child/loopback protocol fixture only; it does not execute a model or prove
 * sandboxing.
 *
 * `frames` names a file of terminal frames a REAL worker controller produced, one
 * per wake. In that mode this fixture stops inventing evidence and replays them by
 * wake id, which is the only way a test can put the worker's own poll and the
 * parent's evidence reader on the same trial: the two halves live in different
 * processes, and every fix that passed on one side alone went on to fail live.
 */
export async function childFixture(mode = 'complete', frames?: string) {
  const f = await launchFixture();
  const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  f.launch.host.port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  f.launch.workspace.target = f.launch.workspace.source;
  for (const row of f.launch.projections) row.target = row.source;
  const config = JSON.parse(await readFile(f.launch.config, 'utf8'));
  config.host.port = f.launch.host.port; config.agents[0].workspacePath = f.launch.workspace.target;
  config.agents[0].runtimeHomePath = f.launch.projections[0]!.target; config.agents[0].instructions = f.input.instructions;
  const bytes = JSON.stringify(config); f.launch.configSha256 = sha256(bytes);
  await writeFile(f.launch.config, bytes); await f.save();
  await writeFile(f.launch.envFile, `UNIT_CHILD_MODE=${mode}\nNATIVE_TRANSPORT_TOKEN=unit-transport-value\n${frames ? `UNIT_CHILD_FRAMES=${frames}\n` : ''}`);
  await writeFile(join(f.launch.bootstrap!.root, f.launch.bootstrap!.entrypoint), worker);
  return f;
}
const worker = `
const fs=require('node:fs'),http=require('node:http'),crypto=require('node:crypto'),path=require('node:path');
const args=Object.fromEntries(process.argv.slice(2).reduce((rows,v,i,all)=>i%2?rows:[...rows,[v.slice(2),all[i+1]]],[]));
const launch=JSON.parse(fs.readFileSync(args.launch)),token=fs.readFileSync(args['token-file'],'utf8').trim(),trial=args['trial-id'],mode=process.env.UNIT_CHILD_MODE;
fs.writeFileSync(path.join(launch.controlRoot,'child-env.json'),JSON.stringify({fresh:!process.env.UNIT_PARENT_SECRET,home:process.env.HOME,transport:process.env.NATIVE_TRANSPORT_TOKEN,pid:process.pid}));
if(mode==='noisy'){console.log('Bootstrap progress');process.stderr.write('Unit diagnostic');}
if(mode==='leak'){process.stderr.write('upstream refused: Bearer sk-unit-'+'A1b2C3d4'.repeat(6)+'\\n');process.stderr.write(JSON.stringify({schema:'paideia.daimon-native.start-failed.v1',error:'unit missing native library'})+'\\n');process.exit(1);}
if(mode==='exit'){process.stderr.write(JSON.stringify({schema:'paideia.daimon-native.start-failed.v1',error:'unit missing native library'})+'\\n');process.exit(1);}if(mode==='overflow'){process.stdout.write('X'.repeat(1100000));setInterval(()=>{},1000);return;}
let terminal;const replay=process.env.UNIT_CHILD_FRAMES?JSON.parse(fs.readFileSync(process.env.UNIT_CHILD_FRAMES,'utf8')):undefined;const health={version:'noopolis.daimon.organization-runtime-health.v1',state:'running',agents:[{agentId:mode==='bad-health'?'foreign':launch.agent.id}]};
// The real worker stops its own Daimon host as soon as a delivery closes its execution and
// stays deferred with no continuation left, so the caller's closure query lands on a stopped
// runtime. Daimon seals the v2 activity projection at that stop and keeps answering it;
// an 'unanswerable' mode reproduces the host that answers HTTP 503 native_host_unavailable there.
let hostStopped=false,wakes=0,budget=0,stopOutcome,items=[],admitted=[],closed=[];
// Daimon's real seal keeps one accepted-delivery record per wake of the trial, so a
// continued trial's projection is never the single-item shape one wake produces.
const activity=()=>({version:'noopolis.daimon.organization-runtime-activity.v2',
state:hostStopped?'stopped':'running',items,
// A host that stopped with work still admitted seals that honestly, and the caller
// must refuse the closure rather than read the empty-list case into it.
// Production admits an execution for as long as its wake runs and drops it when the
// wake closes, which is the whole of the live quiescence answer: a worker still in a
// turn reports it here, and a caller reading anything else is reading its own notes.
executions:hostStopped&&mode.endsWith('-busy-seal')?[{agent_id:launch.agent.id,execution_id:'x'.repeat(64),state:'running',delivery_ids:[]}]
// A projection carrying an execution that is not this agent's cannot be counted at
// all, and a count nobody can account for is the one answer closure must refuse.
:mode==='foreign-execution'?[{agent_id:'another-agent',execution_id:'y'.repeat(64),state:'running',delivery_ids:[]}]
:admitted.length?admitted:terminal?.activity?.executions??[]});
// The worker settles its stop exactly once and every later /trial/stop replays that
// same value, including an internal stop that did not acknowledge: control.ts races
// host.stop() against a 5s deadline and memoizes whatever it got.
const settleStop=()=>{hostStopped=true;stopOutcome=stopOutcome??(mode==='bad-stop'||mode.endsWith('-stop-unknown')
?{schema:'paideia.daimon-native.stop.v1',state:'unknown',quiescence:'unknown',error:'unit native shutdown deadline exceeded'}
:{schema:'paideia.daimon-native.stop.v1',state:'acknowledged',quiescence:'unknown',containmentVerification:'parent-container-owner'});return stopOutcome;};
const server=http.createServer(async(req,res)=>{if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);res.end();return;}
if(req.url==='/v2/activity'&&hostStopped&&mode.endsWith('-unanswerable')){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'native_host_unavailable'}));return;}
res.writeHead(200,{'content-type':'application/json'});
if(req.url==='/trial/health'){res.end(JSON.stringify(health));return;}
if(req.url==='/v2/activity'){res.end(JSON.stringify(activity()));return;}
if(req.url==='/trial/stop'){res.end(JSON.stringify(settleStop()));return;}
// An admitted execution names the deliveries it covers, because that projection is
// the runtime's own binding of a delivery to an execution and the only thing that
// answers for a wake whose receipt has already dropped its execution id.
if(req.url==='/trial/run'){const running={agent_id:launch.agent.id,execution_id:crypto.randomUUID(),state:'running',delivery_ids:[]};admitted=[...admitted,running];
if(mode==='stall')return;if(mode==='die-mid-turn'){process.stderr.write('worker: stream bound crossed, terminating\\n');server.closeAllConnections();process.exit(1);}let text='';for await(const chunk of req)text+=chunk;const input=JSON.parse(text),id=crypto.randomUUID(),at=new Date().toISOString();
// The runtime's own binding of this delivery to the execution running it: the
// projection names the delivery ids an admitted execution covers.
running.delivery_ids=[trial+':'+input.wakeId];
admitted=admitted.filter(row=>row!==running);
// A real worker's own frames, replayed verbatim: this fixture authors nothing in
// this mode, so what the reader parses is exactly what the worker published.
if(replay){terminal=replay.find(row=>row.wakeId===input.wakeId);if(!terminal){res.end('{}');return;}items=[...items,{...terminal.receipt,active:false}];res.end(JSON.stringify(terminal));return;}
if(!wakes++)budget=input.controls?.maxExternalDeliveries??0;
const receipt={version:'noopolis.daimon.wake-receipt-status.v2',acceptance_id:crypto.randomUUID(),agent_id:launch.agent.id,delivery_id:trial+':'+input.wakeId,request_digest:'a'.repeat(64),state:'completed',accepted_at:at,updated_at:at,execution_id:id};
items=[...items,{...receipt,active:false,queue_position:wakes}];
const closedTrace={schema:'daimon.turn_trace.v1',agent_id:launch.agent.id,turn_id:id,started_at:at,completed_at:at,status:'completed',tools:[]};
closed=[...closed,closedTrace];
// Every wake of a continued trial closes an execution of its own, and a worker that
// does not strip its own history publishes all of them on the frame. The frame still
// names the one THIS wake closed; the '-history' modes are that shape, with the two
// ways it can go wrong beside it: an earlier trace that is not this agent's work at
// all, and two traces answering to the one execution the frame names.
const history=mode.includes('-history')?closed.map(row=>({...row})):[closedTrace];
// Both faults are injected only once the trial HAS history, so neither can be
// mistaken for the arity: the first wake of each mode publishes a clean single trace.
if(history.length>1&&mode.endsWith('-foreign'))history[0]={...history[0],agent_id:'another-agent'};
if(history.length>1&&mode.endsWith('-ambiguous'))history.push({...closedTrace});
terminal={schema:'paideia.daimon-native.trial.v1',trialId:trial,wakeId:input.wakeId,agentId:launch.agent.id,model:launch.agent.model,configSha256:launch.configSha256,status:'completed',startedAt:at,completedAt:at,executionId:id,receipt,activity:{version:'noopolis.daimon.organization-runtime-activity.v2',items:[{...receipt,active:false}],executions:[]},native:{traces:history,usage:[{v:'noopolis.daimon.turn-usage.v1',agent:launch.agent.id,wake:id,engine:'codex',input:100,output:20,cache_read:40,total:120,complete:true}],toolReceipts:[],modelContexts:[{model:launch.agent.model}]},coverage:[{channel:'usage',completeness:'complete',ordering:'source'}]};
// Daimon CLEARS the receipt's execution id when the subject defers the delivery,
// so a deferred wake's frame names an execution its own receipt no longer does.
// A fixture that kept it made every reader test bind through a field production
// never supplies on this path.
if((mode.startsWith('blocked')||mode==='undisposed')&&(input.wakeId==='task'||mode.startsWith('blocked-always'))){terminal.status='failed';terminal.blocked='awaiting-external-input';receipt.state='accepted';receipt.deferred=true;delete receipt.execution_id;
if(wakes>budget)settleStop();
terminal.error='Native execution completed; delivery blocked awaiting external input';
// Production derives \`blocked\` from the deferred marker, so a delivery without one
// never carries it; control.ts reports the disposition it actually found and stops
// the host on its own failure path. A fixture pairing the two is a shape nothing emits.
// A reclaimed-undisposed delivery keeps its execution id; only a deferral clears it.
if(mode==='blocked-no-deferred'||mode==='undisposed'){delete receipt.deferred;delete terminal.blocked;receipt.execution_id=id;receipt.code='active_wake_aborted';
terminal.error='Native execution completed; delivery reclaimed undisposed (active_wake_aborted)';settleStop();}
if(mode==='blocked-failed-trace')terminal.native.traces[0].status='failed';
if(mode==='blocked-active')terminal.activity.executions=[{agent_id:launch.agent.id,turn_id:id}];
if(mode==='blocked-wrong-execution')terminal.executionId='foreign';
// The same observed shape — a deferred delivery over a closed trace, on a frame that
// names an execution nothing answers to — placed on the wakes a continued trial adds.
// '-unbound-continuation' binds the assignment and loses only its continuations, which
// is the trial that had an admissible frame and published none; '-unbound' loses every
// wake, so nothing in it may be selected however many frames it published.
if(mode==='blocked-always-unbound'||mode.startsWith('blocked-always-unbound-continuation')&&input.wakeId!=='task')terminal.executionId='foreign';
if(mode==='blocked-always-failed-continuation-foreign'&&input.wakeId!=='task')terminal.native.traces[0].status='failed';
if(mode.endsWith('-continuation-foreign')&&input.wakeId!=='task')terminal.native.traces.push({...closedTrace,turn_id:'foreign-execution',agent_id:'another-agent'});}
// A closed execution the broker sealed on the subject's own declared timeout: the
// worker labels the frame only when that execution's own usage row says so;
// '-unbacked' is a label that row does not support.
if(mode.startsWith('limit')){terminal.status='failed';receipt.state='failed';closedTrace.status='failed';closedTrace.error={message:'engine broker turn failed (limit_exceeded; limit=timeout)',stage:'engine_prompt'};
terminal.native.usage[0].complete=false;terminal.native.usage[0].limit_reason=mode.startsWith('limit-unlabelled')||mode==='limit-unbacked'?'none':'timeout';terminal.coverage=[{channel:'usage',completeness:'partial',ordering:'source'}];
terminal.error='Native execution failed: Grok broker turn limit_exceeded (limit_reason timeout)';if(!mode.startsWith('limit-unlabelled'))terminal.limit='timeout';
// A timeout counts only once the trace spans the configured wake ceiling (20s here);
// '-idle' is Daimon's idle watchdog sealing the same reason after a short stall.
closedTrace.started_at=new Date(Date.parse(at)-(mode==='limit-idle'?1000:20000)).toISOString();
// Daimon's retry shape: the failed execution ran again under a fresh id, and after that
// failed too the receipt is accepted, deferred and no longer names an execution.
if(mode==='limit-retried'){const first={...closedTrace,turn_id:crypto.randomUUID()};terminal.native.traces=[first,closedTrace];
terminal.native.usage=[{...terminal.native.usage[0],wake:first.turn_id},terminal.native.usage[0]];receipt.state='accepted';receipt.deferred=true;delete receipt.execution_id;
terminal.activity.items=[{...receipt,active:false}];}
settleStop();}
if(mode==='bad-terminal')terminal.trialId='foreign';
// A frame whose receipt answers for another trial's delivery, with every other
// identity on the frame itself matching: the delivery is the only thing that says so.
if(mode==='foreign-delivery')receipt.delivery_id='other-trial:'+input.wakeId;
res.end(JSON.stringify(terminal));return;}
res.end('{}');});
const engine=launch.agent.engine==='grok'?{engine:'grok',reasoningEffort:mode==='bad-effort'?'high':launch.agent.reasoningEffort}:{};
server.listen(launch.host.port,'127.0.0.1',()=>console.log(JSON.stringify({schema:'paideia.daimon-native.ready.v1',trialId:mode==='bad-ready'?'foreign':trial,configSha256:launch.configSha256,agentId:launch.agent.id,model:mode==='bad-model'?'grok-4.5':launch.agent.model,port:launch.host.port,...engine})));
process.on('SIGTERM',()=>{if(mode==='ignore-term')return;server.closeAllConnections();server.close(()=>process.exit(0));});
`;
