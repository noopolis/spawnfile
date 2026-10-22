import { openExperimentStore } from '../../storage/index.js';
import { parseDatasetYaml, resolveDataset } from '../../cases/index.js';
import { createEvaluationRegistry } from '../../evaluation/index.js';
import type { ComparisonOptions } from './types.js';
import { afterEach, expect, it, vi } from 'vitest';
import { rm, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrainingCheckpoint } from '../training/index.js';
import { snapshotCandidate, deriveAuthoredCandidate } from '../../candidates/index.js';
import { InferenceFailure } from '../../inference/index.js';
import type { InferenceProvider } from '../../contracts/execution.js';
import { compareCandidates } from './run.js';
const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
it('supports direct public comparison without a checkpoint or progress observer and protects held-out captures',async()=>{
  const f=await comparisonFixture();roots.push(f.root);
  f.options.onProgress=undefined;
  const observe=vi.fn();f.options.native.observeEvent=observe;
  const report=await compareCandidates(f.options);
  expect(report.trials).toHaveLength(6);expect(observe).toHaveBeenCalled();
  expect(report.pairs.every(pair=>pair.delta===0)).toBe(true);
  await expect(f.options.native.store.readReplay(report.trials[4]!.id,{audience:'optimizer',phase:'training'})).rejects.toThrow();
});
it('rejects invalid identity/name/budget or a comparison repair fork before any native work',async()=>{
  const f=await comparisonFixture();roots.push(f.root);
  for(const candidate of [f.options.baseline,deriveAuthoredCandidate(f.options.baseline,{'AGENTS.md':'Other.'})]) {
    if(candidate===f.options.baseline) await expect(compareCandidates({...f.options,candidate})).rejects.toThrow('authored child');
  }
  for(const name of ['',' '.repeat(2),'n'.repeat(121)]) await expect(compareCandidates({...f.options,name})).rejects.toThrow('name');
  for(const maxTrials of [5,NaN,10001]) await expect(compareCandidates({...f.options,maxTrials})).rejects.toThrow('budget');
  await expect(compareCandidates({...f.options,checkpoint:{directory:join(f.root,'cp'),identity:'fixed',resume:false,
    fork:{} as NonNullable<NonNullable<typeof f.options.checkpoint>['fork']>}})).rejects.toThrow('does not support');
  expect(f.starts).toEqual([]);
});
it('recovers a real capture persisted before its checkpoint completion without repeating the native agent',async()=>{
  const f=await comparisonFixture();roots.push(f.root);
  f.options.checkpoint={directory:join(f.root,'checkpoint'),identity:'same',resume:false};
  const complete=vi.spyOn(TrainingCheckpoint.prototype,'complete').mockRejectedValueOnce(new Error('checkpoint interrupted'));
  await expect(compareCandidates(f.options)).rejects.toThrow('checkpoint interrupted');
  expect(f.starts).toHaveLength(1);complete.mockRestore();
  const resumed=await compareCandidates({...f.options,checkpoint:{...f.options.checkpoint,resume:true}});
  expect(f.starts).toHaveLength(6);expect(resumed.trials[0]!.id).toBe(f.starts[0]);
  expect(resumed.pairs).toHaveLength(3);
});
it('rescores a classified judge outage once, retains subject usage and prior rescore across exact resume',async()=>{
  let fail=true,calls=0;
  const judge:InferenceProvider={id:'fixture',capabilities:{tools:'disabled',billing:'local',temperature:false,seed:false},
    async generate(){calls++;if(fail)throw new InferenceFailure('quota','fixture unavailable');
      return {text:JSON.stringify({score:1,verdict:'pass',reasons:['OK'],citations:[{source:'input',quote:'OK'}]}),model:'judge',route:'fixture',usage:null};}};
  const f=await comparisonFixture(judge);roots.push(f.root);
  f.options.checkpoint={directory:join(f.root,'checkpoint'),identity:'fixed',resume:false,maxRecoveryAttempts:1};
  await expect(compareCandidates(f.options)).rejects.toThrow('unscorable');
  expect(f.starts).toHaveLength(1);fail=false;
  const options={...f.options,checkpoint:{...f.options.checkpoint,resume:true}};
  const report=await compareCandidates(options);
  expect(f.starts).toHaveLength(6);expect(report.rescores).toHaveLength(1);
  expect(report.trials[0]!.status).toBe('error');expect(report.rescores![0]!.status).toBe('pass');
  expect(report.pairs[0]!.baselineScore).toBe(1);
  const count=calls;const resumed=await compareCandidates(options);
  expect(f.starts).toHaveLength(6);expect(calls).toBe(count);expect(resumed.rescores).toEqual(report.rescores);
  expect(f.progress.some(event=>event.type==='trial.rescore.restored')).toBe(true);
});

async function comparisonFixture(judge?: InferenceProvider) {
  const root = await mkdtemp(join(tmpdir(), 'comparison-core-'));
  const source = join(root, 'source'); await mkdir(source);
  await writeFile(join(source, 'AGENTS.md'), 'Baseline.');
  const baseline = await snapshotCandidate({ sourceRoot: source, resources: [{ id: 'instructions', sourcePath: 'AGENTS.md',
    destinations: [{ kind: 'instructions', path: 'AGENTS.md' }], edit: 'whole-file' }] });
  const dataset = (id: string) => resolveDataset(parseDatasetYaml(JSON.stringify({ schema: 'paideia.dataset.v1', id,
    checks: judge ? [{ id:'quality', eval:'llm-rubric', input:'output.text', judge:'quality', minimum:0.8, rubric:{prompt:'Is it OK?'} }]
      : [{ id:'quality', eval:'equals', input:'output.text', value:'OK' }],
    records: [{ id, group:id, input:{ prompt:`Reply OK for ${id}.` } }] })), judge ? { registry:{judges:{quality:{version:'fixture'}}} } : {});
  const starts: string[] = [], progress: {type:string;payload:unknown}[] = [];
  const storeRoot = join(root, 'store'), store = await openExperimentStore(storeRoot);
  const options: ComparisonOptions = { id:'comparison', name:'Authored', baseline,
    candidate: deriveAuthoredCandidate(baseline, {'AGENTS.md':'Authored.'}),
    train:dataset('train'), validation:dataset('validation'), test:dataset('sealed'), maxTrials:6,
    native: { store, storeRoot, root:join(root,'trials'), model:'fixture', timeoutMs:2000,
      registry:createEvaluationRegistry(), evaluation:{judges:judge ? {quality:{provider:judge,model:'judge'}} : {},embeddings:{},readText:async()=>''},
      adapter:{id:'fixture',capabilities:{toolTrace:'none',liveObservations:true,cancellation:'native-handle',multiTurn:false,
        resources:['instructions'],isolation:'test',readIsolation:'declared-paths',protectedPaths:true},
        async start(input) {
          starts.push(input.trialId);
          return { async run(turn) {
            await input.onObservation({id:`${input.trialId}/${turn.id}`,type:'output',text:'OK',source:'fixture',seq:1,
              timestamp:new Date().toISOString(),trialId:input.trialId,wakeId:turn.id});
            return {status:'completed',text:'OK',usage:{inputTokens:10,cachedInputTokens:0,outputTokens:1,reasoningTokens:null,source:'fixture'},
              coverage:[{channel:'output',completeness:'complete',ordering:'source'}]};
          },async stop(reason) {return {state:'acknowledged',scope:'native-handle',quiescence:'confirmed',remoteWork:'unknown',reason,detail:'fixture'};} };
        } },
    },
    onProgress:async event=>{progress.push(event);},
  };
  return {root,options,starts,progress};
}
