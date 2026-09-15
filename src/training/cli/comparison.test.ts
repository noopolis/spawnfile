import { afterEach, expect, it } from 'vitest';
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cliFixture, datasetText, fixtureAdapter } from './fixture.js';
import { main } from './commands.js';
import { loadInvocationViewer, startLiveViewer } from './viewer.js';
import { projectTrials } from '../../viewer/index.js';
import type { DspyResult } from '../optimization/index.js';
import { snapshotCandidate, deriveAuthoredCandidate } from '../candidates/index.js';
import { openExperimentStore } from '../storage/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const f = await cliFixture(); roots.push(f.root);
  await writeFile(join(f.root, 'variant.md'), 'IMPROVED\n');
  await writeFile(join(f.root, 'train.paideia.yaml'), `${datasetText([{ id: 'train', group: 'a' }, { id: 'validation', group: 'b' }])}
training:
  models:
    judge: { provider: grok-subscription, model: unused }
  comparison:
    candidate:
      name: Skill dispatch
      replacements:
        - { resource: AGENTS.md, source: variant.md }
  budget: { max_trials: 6, timeout_ms: 20000 }
  validation_groups: [b]
  test: test.paideia.yaml
`);
  await writeFile(join(f.root, 'test.paideia.yaml'), datasetText([{ id: 'sealed', group: 'sealed' }]));
  f.dependencies.inference = () => { throw new Error('Comparison constructed an optimizer provider'); };
  f.dependencies.modelInference = () => { throw new Error('Mechanical cases need no inference'); };
  return { ...f, argv: ['train', '--train', 'train.paideia.yaml', ...f.nativeArgs, '--editable', 'AGENTS.md'] };
}
async function report(root: string) {
  const index = JSON.parse(await readFile(join(root, 'out/invocation.json'), 'utf8'));
  const store = await openExperimentStore(join(root, 'out'));
  return JSON.parse((await store.readBlob(index.report, { audience: 'operator', phase: 'test', frozenCandidateIds: [index.candidateId] })).toString());
}
it('runs authored YAML through the real CLI, records paired arms, streams and resumes without an optimizer', async () => {
  const f = await fixture();
  const identities: { candidateId: string; nativeCalls: number }[] = [];
  f.dependencies.spawnfile = { id: 'comparison-identity', version: '1', executionIdentity(context) {
    expect(context.bridge).toBeUndefined();
    expect(context.comparisonCandidateId).toMatch(/^sha256:[a-f0-9]{64}$/);
    identities.push({ candidateId: context.comparisonCandidateId!, nativeCalls: f.observedInstructions.length });
    return `isolated-comparison:${context.comparisonCandidateId}`;
  }, createAdapter() { throw new Error('Unused project adapter'); },
  async prepareEnvironment() { throw new Error('Unused project preparation'); } };
  const argv = [...f.argv, '--view', '0'];
  expect(await main(argv, f.io, f.dependencies), f.stderr.join('')).toBe(0);
  expect(f.observedInstructions).toEqual(['BASE\n', 'IMPROVED\n', 'BASE\n', 'IMPROVED\n', 'BASE\n', 'IMPROVED\n']);
  const first = await report(f.root);
  expect(first.schema).toBe('paideia.comparison.v1');
  expect(identities[0]).toEqual({ candidateId: first.candidate.id, nativeCalls: 0 });
  expect(first.optimizer).toBeUndefined();
  expect(first.provenance).toEqual({ mode: 'authored-comparison', optimizerCalls: 0 });
  expect(first.pairs.map((p: { baselineScore: number; candidateScore: number; delta: number }) => [p.baselineScore, p.candidateScore, p.delta])).toEqual([[0,1,1],[0,1,1],[0,1,1]]);
  const events = f.stdout.map(line => JSON.parse(line));
  expect(events.findIndex(event => event.type === 'comparison.frozen')).toBeLessThan(events.findIndex(event => event.type === 'trial.queued' && event.phase === 'test'));
  expect(events.some(event => event.type?.startsWith('optimizer.'))).toBe(false);
  const view = await (await loadInvocationViewer(join(f.root, 'out')))();
  expect(view.candidates.map(candidate => candidate.label)).toEqual(['Baseline', 'Skill dispatch']);
  expect(view.optimizer).toBeUndefined(); expect(view.trials).toHaveLength(6);
  expect(await main([...argv, '--resume'], f.io, f.dependencies)).toBe(0);
  expect(f.observedInstructions).toHaveLength(6);
  const resumed = await report(f.root);
  expect(resumed.trials.map((row: { id: string }) => row.id)).toEqual(first.trials.map((row: { id: string }) => row.id));
  expect(resumed.costs).toEqual(first.costs);
  await writeFile(join(f.root, 'variant.md'), 'IMPROVED differently\n');
  expect(await main([...argv, '--resume'], f.io, f.dependencies)).toBe(2);
  expect(f.stderr.join('')).toContain('Command checkpoint inputs changed');
  expect(f.observedInstructions).toHaveLength(6);
}, 30000);

it('resumes interruption after a settled trial without repeating it', async () => {
  const f = await fixture(); const abort = new AbortController();
  expect(await main(f.argv, { ...f.io, signal: abort.signal, stdout(text) {
    f.stdout.push(text); if (JSON.parse(text).type === 'trial.finished') abort.abort();
  } }, f.dependencies)).toBe(130);
  expect(f.observedInstructions).toHaveLength(1);
  const partial = await (await loadInvocationViewer(join(f.root, 'out')))();
  expect(partial.candidates.map(candidate=>candidate.label)).toEqual(['Baseline','Skill dispatch']);
  expect(partial.cases.some(record=>record.split==='test')).toBe(false);
  expect(await main([...f.argv, '--resume'], f.io, f.dependencies), f.stderr.join('')).toBe(0);
  expect(f.observedInstructions).toHaveLength(6);
});

it('estimates exact paired calls without providers or output writes', async () => {
  const f = await fixture(); f.dependencies.adapter = () => { throw new Error('Dry run constructed native runtime'); };
  expect(await main([...f.argv, '--dry-run'], f.io, f.dependencies), f.stderr.join('')).toBe(0);
  const plan = JSON.parse(f.stdout.at(-1)!);
  expect(plan.comparison).toMatchObject({ name: 'Skill dispatch', optimizerCalls: 0 });
  expect(plan.budget).toEqual({ maxTrials: 6, metricCalls: 4, reservedTestTrials: 2, maxProposals: 0 });
  expect(plan.lines.map((line: { role: string; plannedCalls: number }) => [line.role, line.plannedCalls])).toEqual([['subject',4],['subject',2]]);
  await expect(readFile(join(f.root, 'out/invocation.json'))).rejects.toThrow();
});

it.each(['missing', 'locked', 'unknown', 'noop', 'escape', 'escaping-link', 'budget', 'optimizer'])('rejects invalid comparison %s before native/inference/output', async mode => {
  const f = await fixture();
  let yaml = await readFile(join(f.root, 'train.paideia.yaml'), 'utf8');
  let args = f.argv;
  if (mode === 'missing') yaml = yaml.replace('source: variant.md', 'source: absent.md');
  if (mode === 'locked') args = f.argv.slice(0, -2);
  if (mode === 'unknown') yaml = yaml.replace('resource: AGENTS.md', 'resource: unknown.md');
  if (mode === 'noop') await writeFile(join(f.root, 'variant.md'), 'BASE\n');
  if (mode === 'budget') yaml = yaml.replace('max_trials: 6', 'max_trials: 5');
  if (mode === 'optimizer') args = [...args, '--optimizer-model', 'no'];
  if (mode === 'escaping-link') {
    const other = await cliFixture(); roots.push(other.root);
    await rm(join(f.root, 'variant.md')); await symlink(join(other.root, 'AGENTS.md'), join(f.root, 'variant.md'));
  }
  if (mode === 'escape') { await symlink(join(f.root, 'AGENTS.md'), join(f.root, 'outside.md')); yaml = yaml.replace('source: variant.md', 'source: ../outside.md'); }
  await writeFile(join(f.root, 'train.paideia.yaml'), yaml);
  f.dependencies.adapter = () => { throw new Error('Invalid comparison constructed runtime'); };
  expect(await main(args, f.io, f.dependencies)).toBe(2);
  expect(f.stderr.join('')).not.toContain('constructed');
  expect(f.observedInstructions).toHaveLength(0);
  await expect(readFile(join(f.root, 'out/checkpoint/command.json'))).rejects.toThrow();
});

it('preserves a valid failing authored measurement and reports nonzero outcome', async () => {
  const f = await fixture(); await writeFile(join(f.root, 'variant.md'), 'ALSO BAD\n');
  expect(await main(f.argv, f.io, f.dependencies)).toBe(1);
  expect((await report(f.root)).pairs.map((pair: {delta:number})=>pair.delta)).toEqual([0,0,0]);
});

it('refuses to replay an incomplete native capture as completed', async () => {
  const f = await fixture(); f.dependencies.adapter = runtime => fixtureAdapter(runtime, f.observedInstructions, 'failed');
  expect(await main(f.argv, f.io, f.dependencies)).toBe(2);
  expect(f.observedInstructions).toHaveLength(1);
  expect(await main([...f.argv, '--resume'], f.io, f.dependencies)).toBe(2);
  expect(f.observedInstructions).toHaveLength(1);
});


it('serves named live comparison arms with no GEPA panel even when caller supplies an optimizer-shaped budget', async () => {
  const f = await fixture();
  const baseline = await snapshotCandidate({ sourceRoot:f.root, resources:[{id:'instructions',sourcePath:'AGENTS.md',
    destinations:[{kind:'instructions',path:'AGENTS.md'}],edit:'whole-file'}] });
  const candidate = deriveAuthoredCandidate(baseline,{'AGENTS.md':'IMPROVED'});
  const comparison = {candidate,name:'<script>authored</script>'};
  const store = await openExperimentStore(join(f.root,'view-store'));
  const urls:string[]=[];
  const live = await startLiveViewer({port:0,io:{...f.io,stdout:text=>urls.push(JSON.parse(text).viewer)},store,id:'comparison-view',
    datasetId:'dataset',planDigest:'plan',baseline,comparison,cases:[{id:'train',split:'train'}],testCases:[{id:'sealed',split:'test'}],
    budget:{maxMetricCalls:4,maxProposals:1}});
  try {
    const snapshot=async()=>await(await fetch(`${urls[0]}/api/data`)).json();
    expect((await snapshot()).optimizer).toBeUndefined();
    expect((await snapshot()).candidates.map((row:{label:string})=>row.label)).toEqual(['Baseline',comparison.name]);
    await live.observe({type:'comparison.started',payload:{train:['train'],validation:['validation']}});
    expect((await snapshot()).experiment.status).toBe('comparing frozen arms');
    expect(JSON.stringify(await snapshot())).not.toContain('sealed');
    await live.observe({type:'comparison.frozen',payload:{optimizer:{untrusted:'not optimizer provenance'}}});
    expect((await snapshot()).optimizer).toBeUndefined();
    expect((await snapshot()).cases.some((row:{id:string})=>row.id==='sealed')).toBe(true);
    const html=await(await fetch(urls[0]!)).text();
    expect(html).not.toContain('<script>authored</script>'); expect(html).toContain('&lt;script&gt;authored&lt;/script&gt;');
    await live.observe({type:'experiment.failed',payload:{}});
    expect((await snapshot()).optimizer).toBeUndefined();
    expect((await snapshot()).cases.some((row:{id:string})=>row.id==='sealed')).toBe(false);
  } finally { await live.close(); }
  expect(()=>projectTrials({id:'bad',title:'bad',phase:'train',status:'failed',updatedAt:'now',baseline,comparison,
    cases:[],trials:[],optimizer:{} as DspyResult})).toThrow('cannot contain optimizer');
});
