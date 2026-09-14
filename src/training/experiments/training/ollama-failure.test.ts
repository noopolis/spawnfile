import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createOllamaInference, createRoutedInference } from '../../inference/index.js';
import { createEvaluationRegistry, evaluatePlan, createJudgeCache } from '../../evaluation/index.js';
import { evaluationContext, snapshot } from '../../testing/index.js';

const servers:Server[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).map(server=>new Promise<void>(resolve=>{
  server.close(()=>resolve());server.closeAllConnections();
})));});
async function fixture() {
  const requests:Array<Record<string,unknown>>=[];
  const server=createServer(async(request,response)=>{
    let body='';for await(const chunk of request)body+=String(chunk);requests.push(JSON.parse(body));
    response.writeHead(200,{'content-type':'application/json'});
    response.end(JSON.stringify({done:true,done_reason:'length',model:'gpt-oss:20b',prompt_eval_count:2445,eval_count:1651,
      message:{content:'TRUNCATED PRIVATE TEXT',thinking:'HIDDEN REASONING'}}));
  });servers.push(server);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const endpoint=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {requests,provider:createOllamaInference({baseUrl:endpoint}),route:`ollama:${endpoint}/`};
}
const stages=[{id:'writing',checks:[{id:'clarity',eval:'llm-rubric',judge:'judge',input:'output.text',
  minimum:0.8,rubric:{prompt:'Grade clarity.'}}],score:{linear:{clarity:1}},gate:{passed:'clarity'}}];

it.each([false,true])('retains counted truncation evidence through actual HTTP and the plan evaluator (routed=%s)',async routed=>{
  const f=await fixture();const backup={...f.provider,id:'backup',generate:vi.fn(async()=>({text:'must not run',model:'backup',route:'backup',usage:null}))};
  const provider=routed?createRoutedInference({id:'policy',routes:[{provider:f.provider,model:'requested'},
    {provider:backup,model:'backup'}],maxAttempts:2,timeoutMs:5000}):f.provider;
  const observe=vi.fn();
  const context=evaluationContext({snapshot:snapshot({output:'Article'}),judges:{judge:{provider,model:'requested',identity:'frozen',
    cache:createJudgeCache({maxEntries:10})}},observeJudgeAttempt:observe});
  const report=await evaluatePlan(stages,context,createEvaluationRegistry());
  expect(report.status).toBe('error');expect(report.judgeCalls).toHaveLength(1);
  expect(report.judgeCalls![0]).toMatchObject({outcome:'generation-error',failureKind:'protocol',responseModel:'gpt-oss:20b',
    responseRoute:f.route,usage:{inputTokens:2445,outputTokens:1651,cachedInputTokens:null,reasoningTokens:null}});
  expect(report.checks.clarity!.usage).toEqual([report.judgeCalls![0]!.usage]);
  expect(observe.mock.calls[0]![0].response).toBe('');
  expect(JSON.stringify(report)).not.toMatch(/TRUNCATED PRIVATE TEXT|HIDDEN REASONING/);
  expect(backup.generate).not.toHaveBeenCalled();expect(f.requests).toHaveLength(1);
  expect(f.requests[0]).not.toHaveProperty('tools');expect(f.requests[0]!.model).toBe('requested');
  expect((await evaluatePlan(stages,context,createEvaluationRegistry())).status).toBe('error');
  expect(f.requests).toHaveLength(2);expect(backup.generate).not.toHaveBeenCalled();
});
