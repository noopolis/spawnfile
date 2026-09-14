import * as inferenceFactory from './inference.js';
import * as providerPolicies from '../../contracts/inference-policy.js';
import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JudgeRoute } from '../../contracts/evaluation.js';
import type { TrainingConfiguration } from '../../contracts/training-config.js';
import { parseDatasetYaml } from '../../cases/index.js';
import { openExperimentStore } from '../../storage/index.js';
import { cliFixture } from '../fixture.js';
import { main } from '../commands.js';
import { parseArguments, type CliArguments } from '../arguments.js';
import { authoredArguments } from './configuration.js';
import { prepareJudgeCaches } from './cache.js';

const roots: string[] = [];
afterEach(async()=>{vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const training: TrainingConfiguration = {models:{small:{provider:'ollama',model:'local-small'}},
  judges:{clarity:{model:'small',template:{language:'jinja',text:'FIXED TEMPLATE {{ rubric }}'}}},
  cache:{mode:'persistent',namespace:'calibration',directory:'shared-cache',max_entries:10}};
const stages = [{id:'writing',checks:[{id:'clarity',eval:'llm-rubric',judge:'clarity',input:'output.text',minimum:0.8,
  rubric:{prompt:'Be clear.'}}],score:{linear:{clarity:1}},gate:{passed:'clarity'}}];
const document = {schema:'paideia.dataset.v1',id:'cache-test',training,stages,records:[{id:'one',group:'train',input:{prompt:'Write.'}}]};
async function fixture(config=training) {
  const f=await cliFixture(); roots.push(f.root); await mkdir(join(f.root,'evals'));
  const path=join(f.root,'evals/data.yaml'); await writeFile(path,JSON.stringify({...document,training:config}));
  const argv=['evaluate','evals/data.yaml',...f.nativeArgs];
  const args=authoredArguments(parseArguments(argv),f.io);
  return {...f,args,argv,path};
}
function routes(): Record<string,JudgeRoute> {
  return {clarity:{model:'small',identity:'frozen-policy',provider:{id:'local',
    capabilities:{tools:'disabled',billing:'local',temperature:false,seed:false},generate:vi.fn()}}};
}

it('runs real CLI plan evaluation twice, renders Jinja, protects cache and retains original judge provenance without new usage',async()=>{
  const f=await fixture(); let generations=0; const protectedPaths:string[][]=[];
  const dependencies={...f.dependencies,adapter:(runtime:'codex'|'daimon',options:{model:string;timeoutMs:number})=>{
    const adapter=f.dependencies.adapter!(runtime,options);
    return {...adapter,async start(input:Parameters<typeof adapter.start>[0]) {
      protectedPaths.push([...input.protectedPaths??[]]); return adapter.start(input);
    }};
  },modelInference:()=>({id:'local',capabilities:{tools:'disabled' as const,billing:'local' as const,temperature:false,seed:false},
    async generate(request:{prompt:string}) {
      generations++; expect(request.prompt).toContain('FIXED TEMPLATE Be clear.');
      return {model:'local-small-v1',route:'local',usage:{inputTokens:10,cachedInputTokens:0,outputTokens:5,reasoningTokens:null,source:'provider'},
        text:JSON.stringify({score:0.9,verdict:'pass',reasons:['Clear'],citations:[{source:'input',quote:'BAD'}]})};
    }})};
  expect(await main(f.argv,f.io,dependencies)).toBe(0);
  expect(await main([...f.argv.slice(0,-2),'--out','second'],f.io,dependencies)).toBe(0);
  expect(f.stderr).toEqual([]); expect(generations).toBe(1); expect(f.observedInstructions).toHaveLength(2);
  const cachePath=await realpath(join(f.root,'evals/shared-cache'));
  expect(protectedPaths.every(paths=>paths.includes(cachePath))).toBe(true);
  const index=JSON.parse(await readFile(join(f.root,'second/invocation.json'),'utf8'));
  const store=await openExperimentStore(join(f.root,'second'));
  const report=JSON.parse((await store.readBlob(index.report,{audience:'operator',phase:'replay'})).toString());
  const judgment=report.trials[0].evaluation.checks.clarity;
  expect(judgment.judgeCalls).toEqual([]); expect(judgment.usage).toBeUndefined();
  expect(judgment.cache.sourceCalls[0]).toMatchObject({responseModel:'local-small-v1',usage:{inputTokens:10}});
});

it('accepts a maximum-length namespace and canonicalizes protected paths without contacting models',async()=>{
  const f=await fixture({...training,cache:{mode:'persistent',namespace:'n'.repeat(512)}});
  const judges=routes();
  const paths=await prepareJudgeCaches(f.args,judges,join(f.root,'out'));
  expect(paths).toEqual([await realpath(join(f.root,'out/judge-cache'))]);
  expect(judges.clarity!.cache!.persistent).toBe(true);
  expect(judges.clarity!.provider.generate).not.toHaveBeenCalled();
  expect(await prepareJudgeCaches({...f.args,training:undefined},routes(),join(f.root,'empty'))).toEqual([]);
  expect(await prepareJudgeCaches(f.args,{},join(f.root,'empty'))).toEqual([]);
});

it('refuses missing authored identities and existing symlink components before writing outside the dataset',async()=>{
  const f=await fixture(); const judges=routes(); judges.clarity!.identity=undefined;
  await expect(prepareJudgeCaches(f.args,judges,join(f.root,'out'))).rejects.toThrow('authored');
  await mkdir(join(f.root,'outside'));
  await symlink(join(f.root,'outside'),join(f.root,'evals/link'));
  const args:CliArguments={...f.args,training:{...training,cache:{mode:'persistent',namespace:'epoch',directory:'link/cache'}}};
  await expect(prepareJudgeCaches(args,routes(),join(f.root,'out'))).rejects.toThrow('symlink');
  expect(await readdir(join(f.root,'outside'))).toEqual([]);
  for (const directory of ['../outside','/absolute','back\\slash','bad\0path','C:/outside']) {
    await expect(prepareJudgeCaches({...args,training:{...training,cache:{...training.cache!,directory}}},routes(),join(f.root,'out'))).rejects.toThrow('contained');
  }
});

it('validates cache namespace, mode fields and recovery bounds before invoking native factories',async()=>{
  for (const update of [
    {cache:{mode:'persistent'}},{cache:{mode:'persistent',namespace:' '}},{cache:{mode:'persistent',namespace:'x'.repeat(513)}},
    {cache:{mode:'exact',namespace:'epoch'}},{cache:{mode:'off',directory:'cache'}},
    {cache:{mode:'persistent',namespace:'epoch',directory:'../escape'}},
    {recovery:{max_attempts:-1}},{recovery:{max_attempts:11}},{recovery:{max_attempts:0.5}},
  ]) expect(()=>parseDatasetYaml(JSON.stringify({...document,training:{...training,...update}}))).toThrow();
  for (const recovery of [{},{max_attempts:0},{max_attempts:10}]) {
    expect(parseDatasetYaml(JSON.stringify({...document,training:{...training,recovery}})).dataset.training!.recovery).toEqual(recovery);
  }
  const config={...training,optimizer:{model:'small'},test:'test.yaml',validation_groups:['validation']};
  const f=await fixture(config);
  await writeFile(f.path,JSON.stringify({...document,training:config,records:[
    {id:'train',group:'train',input:{prompt:'Write training.'}},
    {id:'validation',group:'validation',input:{prompt:'Write validation.'}},
  ]}));
  await writeFile(join(f.root,'evals/test.yaml'),JSON.stringify({...document,id:'sealed',training:undefined,
    records:[{id:'test',group:'test',input:{prompt:'Write held-out.'}}]}));
  const forbidden=vi.fn(()=>{throw new Error('No native or inference construction');});
  const code=await main(['train','--train','evals/data.yaml','--runtime','codex','--model','subject',
    '--instructions','AGENTS.md','--editable','AGENTS.md','--dry-run'],f.io,{adapter:forbidden,inference:forbidden,modelInference:forbidden,
    spawnfile:{id:'dry',version:'1',judgeCacheRoot:join(f.root,'must-not-exist'),createAdapter:forbidden,prepareEnvironment:forbidden}});
  expect(f.stderr).toEqual([]); expect(code).toBe(0);
  expect(JSON.parse(f.stdout[0]!).budget.maxTrials).toBeGreaterThan(0);
  expect(forbidden).not.toHaveBeenCalled();
  expect(await readdir(join(f.root,'evals'))).toEqual(['data.yaml','test.yaml']);
});


it.each(['grok-subscription', 'claude-subscription'] as const)('misses persistent judgments when primary %s or its fallback policy changes, with unchanged YAML', async primary => {
  const config: TrainingConfiguration = { ...training, models: {
    small: { provider: primary, model: 'fixed' },
    backup: { provider: primary === 'grok-subscription' ? 'claude-subscription' : 'grok-subscription', model: 'fixed-backup' },
  }, judges: { clarity: { ...training.judges!.clarity!, fallbacks: ['backup'] } } };
  const f = await fixture(config);
  let generations = 0;
  const dependencies = { ...f.dependencies, modelInference: () => ({
    id: 'unchanged-provider', capabilities: { tools: 'disabled' as const, billing: 'subscription' as const, temperature: false, seed: false },
    async generate() { generations++; return { model: 'fixed', route: 'unchanged-provider', usage: null,
      text: JSON.stringify({ score: 0.9, verdict: 'pass', reasons: ['Clear'], citations: [{ source: 'input', quote: 'BAD' }] }) }; },
  }) };
  let run = 0;
  const evaluate = async () => {
    const argv = [...f.argv]; argv[argv.indexOf('--out') + 1] = `policy-run-${++run}`;
    expect(await main(argv, f.io, dependencies)).toBe(0);
  };
  // Seed the exact former YAML-only route identity; default execution must never reuse it.
  // Captured hashes from the former canonical({policy, models}) implementation for these exact declarations.
  const legacyHashes = {
    'grok-subscription': '06c6c67791a7f48f6803e872e6ab1c88cb5d901775514fb7a970859934359ace',
    'claude-subscription': '882d117899786d5636216a8528b4dc683d3df672e1bc35fd1e4262c7acdc77ed',
  };
  const legacy = `paideia.authored-judge.v1:sha256:${legacyHashes[primary]}`;
  const factory = inferenceFactory.createTrainingInference;
  const oldRuntime = vi.spyOn(inferenceFactory, 'createTrainingInference').mockImplementation((...args) => {
    const result = factory(...args); result.judges.clarity!.identity = legacy; return result;
  });
  await evaluate(); expect(generations).toBe(1);
  oldRuntime.mockRestore();
  await evaluate(); await evaluate(); expect(generations).toBe(2);
  const original = providerPolicies.trainingRoutePolicies;
  let changed: 'grok-subscription' | 'claude-subscription' = 'grok-subscription';
  vi.spyOn(providerPolicies, 'trainingRoutePolicies').mockImplementation((configuration, route) =>
    original(configuration, route).map(value => value.provider === changed ? { ...value, policy: `${value.policy}:changed` } : value));
  await evaluate(); await evaluate(); expect(generations).toBe(3);
  changed = 'claude-subscription';
  await evaluate(); await evaluate(); expect(generations).toBe(4);
  expect(f.stderr).toEqual([]);
});

it.each([false, true])('never reuses ambient host judgments across declared images (flag-only: %s)', async flagOnly => {
  const f = await fixture(flagOnly ? { ...training, judges: {} } : training);
  if (flagOnly) f.argv.push('--judge', 'clarity=small');
  let generations = 0;
  const integration = { id: 'execution', version: '1', createAdapter: vi.fn(), prepareEnvironment: vi.fn() };
  const inference = () => ({
    id: 'unchanged-provider', capabilities: { tools: 'disabled' as const, billing: 'local' as const, temperature: false, seed: false },
    async generate() { generations++; return { model: 'local-small', route: 'unchanged-provider', usage: null,
      text: JSON.stringify({ score: 0.9, verdict: 'pass', reasons: ['Clear'], citations: [{ source: 'input', quote: 'BAD' }] }) }; },
  });
  const dependencies = { ...f.dependencies, spawnfile: integration, modelInference: inference, inference };
  let run = 0;
  const evaluate = async (inferenceExecutionIdentity?: string) => {
    const argv = [...f.argv]; argv[argv.indexOf('--out') + 1] = `execution-run-${++run}`;
    const code = await main(argv, f.io, { ...dependencies, spawnfile: { ...integration, inferenceExecutionIdentity } });
    expect(f.stderr).toEqual([]); expect(code).toBe(0);
  };
  await evaluate(); await evaluate(); expect(generations).toBe(1);
  await evaluate('image:sha256:one'); await evaluate('image:sha256:one'); expect(generations).toBe(2);
  await evaluate('image:sha256:two'); await evaluate('image:sha256:two'); expect(generations).toBe(3);
  await evaluate(); expect(generations).toBe(3);
  expect(f.stderr).toEqual([]);
});


it('uses writable execution cache storage with readonly dataset inputs through the real CLI, preserving hits and protection', async () => {
  const f = await fixture(); let generations = 0; const protectedPaths: string[][] = [];
  const outputBase = join(f.root, 'writable'); await mkdir(outputBase);
  const judgeCacheRoot = await realpath(outputBase);
  const dependencies = { ...f.dependencies,
    spawnfile: { id: 'container', version: '1', judgeCacheRoot, inferenceExecutionIdentity: 'image:one', createAdapter: vi.fn(), prepareEnvironment: vi.fn() },
    adapter: (runtime: 'codex' | 'daimon', options: { model: string; timeoutMs: number }) => {
      const adapter = f.dependencies.adapter!(runtime, options);
      return { ...adapter, async start(input: Parameters<typeof adapter.start>[0]) {
        protectedPaths.push([...input.protectedPaths ?? []]); return adapter.start(input);
      } };
    }, modelInference: () => ({ id: 'local', capabilities: { tools: 'disabled' as const, billing: 'local' as const, temperature: false, seed: false },
      async generate() { generations++; return { model: 'local-small', route: 'local', usage: null,
        text: JSON.stringify({ score: 0.9, verdict: 'pass', reasons: ['Clear'], citations: [{ source: 'input', quote: 'BAD' }] }) }; } }) };
  const datasetDirectory = join(f.root, 'evals'); await chmod(datasetDirectory, 0o500); await chmod(f.path, 0o400);
  try {
    // Prove the fixture actually cannot create the cache next to its readonly YAML.
    await expect(mkdir(join(datasetDirectory, 'forbidden'))).rejects.toMatchObject({ code: 'EACCES' });
    for (const name of ['one', 'two']) {
      const argv = [...f.argv]; argv[argv.indexOf('--out') + 1] = join(outputBase, name);
      expect(await main(argv, f.io, dependencies)).toBe(0);
    }
    expect(f.stderr).toEqual([]); expect(generations).toBe(1);
    const cache = await realpath(join(judgeCacheRoot, 'shared-cache'));
    expect(protectedPaths).toHaveLength(2); expect(protectedPaths.every(paths => paths.includes(cache))).toBe(true);
    expect(await readdir(datasetDirectory)).toEqual(['data.yaml']);
    expect((await readdir(cache)).length).toBeGreaterThan(0);
  } finally { await chmod(datasetDirectory, 0o700); await chmod(f.path, 0o600); }
});

it('uses an explicit writable base for default caches and rejects aliases, non-directories and relative escapes', async () => {
  const f = await fixture({ ...training, cache: { mode: 'persistent', namespace: 'test' } });
  const directory = join(f.root, 'writable'); await mkdir(directory); const base = await realpath(directory);
  expect(await prepareJudgeCaches(f.args, routes(), join(f.root, 'out'), base)).toEqual([join(base, 'judge-cache')]);
  const alias = join(f.root, 'alias'); await symlink(base, alias);
  for (const invalid of ['relative', alias, await realpath(f.path)]) {
    await expect(prepareJudgeCaches(f.args, routes(), join(f.root, 'out'), invalid)).rejects.toThrow('canonical absolute directory');
  }
  for (const relative of ['../escape', '/absolute']) {
    await expect(prepareJudgeCaches({ ...f.args, training: { ...training, cache: { ...training.cache!, directory: relative } } },
      routes(), join(f.root, 'out'), base)).rejects.toThrow('contained relative');
  }
  await symlink(base, join(base, 'link'));
  await expect(prepareJudgeCaches({ ...f.args, training: { ...training, cache: { ...training.cache!, directory: 'link/escape' } } },
    routes(), join(f.root, 'out'), base)).rejects.toThrow('symlink');
});
