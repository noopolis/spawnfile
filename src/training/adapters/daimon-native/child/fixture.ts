import { createServer } from 'node:net';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { launchFixture } from '../test-fixtures.js';
import { sha256 } from '../receipt/index.js';

/** Real child/loopback protocol fixture only; it does not execute a model or prove sandboxing. */
export async function childFixture(mode = 'complete') {
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
  await writeFile(f.launch.envFile, `UNIT_CHILD_MODE=${mode}\nNATIVE_TRANSPORT_TOKEN=unit-transport-value\n`);
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
let terminal;const health={version:'noopolis.daimon.organization-runtime-health.v1',state:'running',agents:[{agentId:mode==='bad-health'?'foreign':launch.agent.id}]};
// The real worker stops its own Daimon host as soon as a delivery closes its execution and
// stays deferred with no continuation left, so the caller's closure query lands on a stopped
// runtime. Daimon seals the v2 activity projection at that stop and keeps answering it;
// an 'unanswerable' mode reproduces the host that answers HTTP 503 native_host_unavailable there.
let hostStopped=false,wakes=0,budget=0;
const activity=()=>{const base=terminal?.activity??{version:'noopolis.daimon.organization-runtime-activity.v2',items:[],executions:[]};
return hostStopped?{...base,state:'stopped'}:{...base,state:'running'};};
const server=http.createServer(async(req,res)=>{if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);res.end();return;}
if(req.url==='/v2/activity'&&hostStopped&&mode.endsWith('-unanswerable')){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'native_host_unavailable'}));return;}
res.writeHead(200,{'content-type':'application/json'});
if(req.url==='/trial/health'){res.end(JSON.stringify(health));return;}
if(req.url==='/v2/activity'){res.end(JSON.stringify(activity()));return;}
if(req.url==='/trial/stop'){hostStopped=true;res.end(JSON.stringify({schema:'paideia.daimon-native.stop.v1',state:mode==='bad-stop'?'unknown':'acknowledged',quiescence:'unknown'}));return;}
if(req.url==='/trial/run'){if(mode==='stall')return;if(mode==='die-mid-turn'){process.stderr.write('worker: stream bound crossed, terminating\\n');server.closeAllConnections();process.exit(1);}let text='';for await(const chunk of req)text+=chunk;const input=JSON.parse(text),id=crypto.randomUUID(),at=new Date().toISOString();
if(!wakes++)budget=input.controls?.maxExternalDeliveries??0;
const receipt={version:'noopolis.daimon.wake-receipt-status.v2',acceptance_id:crypto.randomUUID(),agent_id:launch.agent.id,delivery_id:trial+':'+input.wakeId,request_digest:'a'.repeat(64),state:'completed',accepted_at:at,updated_at:at,execution_id:id};
terminal={schema:'paideia.daimon-native.trial.v1',trialId:trial,wakeId:input.wakeId,agentId:launch.agent.id,model:launch.agent.model,configSha256:launch.configSha256,status:'completed',startedAt:at,completedAt:at,executionId:id,receipt,activity:{version:'noopolis.daimon.organization-runtime-activity.v2',items:[{...receipt,active:false}],executions:[]},native:{traces:[{schema:'daimon.turn_trace.v1',agent_id:launch.agent.id,turn_id:id,started_at:at,completed_at:at,status:'completed',tools:[]}],usage:[{v:'noopolis.daimon.turn-usage.v1',agent:launch.agent.id,wake:id,engine:'codex',input:100,output:20,cache_read:40,total:120,complete:true}],toolReceipts:[],modelContexts:[{model:launch.agent.model}]},coverage:[{channel:'usage',completeness:'complete',ordering:'source'}]};
if(mode.startsWith('blocked')&&(input.wakeId==='task'||mode.startsWith('blocked-always'))){terminal.status='failed';terminal.blocked='awaiting-external-input';receipt.state='accepted';receipt.deferred=true;
if(wakes>budget)hostStopped=true;
terminal.error='Native execution completed; delivery blocked awaiting external input';
if(mode==='blocked-no-deferred')delete receipt.deferred;
if(mode==='blocked-failed-trace')terminal.native.traces[0].status='failed';
if(mode==='blocked-active')terminal.activity.executions=[{agent_id:launch.agent.id,turn_id:id}];
if(mode==='blocked-wrong-execution')terminal.executionId='foreign';}
if(mode==='bad-terminal')terminal.trialId='foreign';res.end(JSON.stringify(terminal));return;}
res.end('{}');});
const engine=launch.agent.engine==='grok'?{engine:'grok',reasoningEffort:mode==='bad-effort'?'high':launch.agent.reasoningEffort}:{};
server.listen(launch.host.port,'127.0.0.1',()=>console.log(JSON.stringify({schema:'paideia.daimon-native.ready.v1',trialId:mode==='bad-ready'?'foreign':trial,configSha256:launch.configSha256,agentId:launch.agent.id,model:mode==='bad-model'?'grok-4.5':launch.agent.model,port:launch.host.port,...engine})));
process.on('SIGTERM',()=>{if(mode==='ignore-term')return;server.closeAllConnections();server.close(()=>process.exit(0));});
`;
