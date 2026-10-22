import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { InferenceProvider } from '../../contracts/execution.js';
import { createEvaluationRegistry, evaluatePlan } from '../../evaluation/index.js';
import { openJudgeCache } from '../../storage/index.js';
import { evaluationContext, snapshot } from '../../testing/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root,{recursive:true,force:true}))); });
const usage = {inputTokens:10,cachedInputTokens:2,outputTokens:3,reasoningTokens:null,source:'provider'};
const check = { id:'clarity',eval:'llm-rubric',judge:'judge',input:'output.text',rubric:{prompt:'Be precise.'},minimum:0.8 };
const stages = [{id:'writing',checks:[check],score:{linear:{clarity:1}},gate:{passed:'clarity'}}];
const response = JSON.stringify({score:0.9,verdict:'pass',reasons:['Precise'],citations:[{source:'input',quote:'Article'}]});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(),'paideia-plan-cache-')); roots.push(root);
  const options = {root,namespace:'calibration-v1',maxEntries:20,maxBytes:100_000};
  const generate = vi.fn<InferenceProvider['generate']>(async()=>({text:response,model:'actual',usage,route:'local'}));
  const provider: InferenceProvider = {id:'local',capabilities:{tools:'disabled',billing:'local',temperature:false,seed:false},generate};
  const context = evaluationContext({snapshot:snapshot({output:'Article'}),judges:{judge:{provider,model:'model',identity:'policy',
    template:{language:'jinja',text:'CALIBRATION {{ rubric }}'},cacheScope:'dataset-digest:train',cache:await openJudgeCache(options)}}});
  return {options,generate,context};
}

it('preserves YAML route semantics through the real plan engine and reuses persistent provenance without new usage',async()=>{
  const f = await fixture(); const registry = createEvaluationRegistry();
  const first = await evaluatePlan(stages,f.context,registry);
  expect(first.status).toBe('pass'); expect(first.scores.writing!.lower).toBe(0.9);
  expect(f.generate.mock.calls[0]![0].prompt).toContain('CALIBRATION Be precise.');
  f.context.judges.judge!.cache = await openJudgeCache(f.options);
  const hit = await evaluatePlan(stages,f.context,registry);
  expect(hit.status).toBe('pass'); expect(hit.judgeCalls).toBeUndefined();
  expect(hit.checks.clarity!.usage).toBeUndefined();
  expect(hit.checks.clarity!.cache!.sourceCalls).toEqual(first.judgeCalls);
  expect(hit.checks.clarity!.cache!.sourceCallId).toBe(first.judgeCalls![0]!.id);
  expect(f.generate).toHaveBeenCalledTimes(1);
});

it('invalidates plan results on scope, route, template, evidence and threshold drift',async()=>{
  const f = await fixture(); const registry = createEvaluationRegistry();
  await evaluatePlan(stages,f.context,registry);
  for (const scope of ['dataset-digest:validation','dataset-digest:test','new-dataset:train']) {
    f.context.judges.judge!.cacheScope=scope; await evaluatePlan(stages,f.context,registry);
  }
  f.context.judges.judge!.identity='different-routes'; await evaluatePlan(stages,f.context,registry);
  f.context.judges.judge!.template!.text='OTHER {{ rubric }}'; await evaluatePlan(stages,f.context,registry);
  f.context.snapshot=snapshot({output:'Article changed'}); await evaluatePlan(stages,f.context,registry);
  await evaluatePlan([{...stages[0]!,checks:[{...check,minimum:0.95}]}],f.context,registry);
  expect(f.generate).toHaveBeenCalledTimes(8);
});

it('fails before inference without frozen scope and never persists infrastructure errors',async()=>{
  const f = await fixture(); const registry = createEvaluationRegistry();
  f.context.judges.judge!.cacheScope=undefined;
  expect((await evaluatePlan(stages,f.context,registry)).checks.clarity!.reason).toContain('scope');
  expect(f.generate).not.toHaveBeenCalled();
  f.context.judges.judge!.cacheScope='dataset-digest:train';
  f.generate.mockRejectedValueOnce(new Error('quota exhausted'));
  expect((await evaluatePlan(stages,f.context,registry)).status).toBe('error');
  f.context.judges.judge!.cache = await openJudgeCache(f.options);
  expect((await evaluatePlan(stages,f.context,registry)).status).toBe('pass');
  expect(f.generate).toHaveBeenCalledTimes(2);
});

it('honors cancellation while an asynchronous lookup is pending',async()=>{
  const f = await fixture(); const controller = new AbortController();
  f.context.signal=controller.signal;
  f.context.judges.judge!.cache={persistent:true,get:async()=>{controller.abort();return undefined;},put:()=>undefined};
  expect((await evaluatePlan(stages,f.context,createEvaluationRegistry())).status).toBe('error');
  expect(f.generate).not.toHaveBeenCalled();
});
