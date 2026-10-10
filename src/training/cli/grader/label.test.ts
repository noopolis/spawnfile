import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { stringify, parse } from 'yaml';
import { afterEach, describe, it, expect } from 'vitest';
import type { InferenceProvider, InferenceRequest } from '../../contracts/execution.js';
import { loadGrader, loadLabels, type Labels } from '../../graders/index.js';
import { InferenceFailure } from '../../inference/index.js';
import { runLabel, createGraderTeacher } from './label.js';
import { loadLabelInputs, resolveStoredLabels } from './label-inputs.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'grader-label-')); directories.push(dir);
  const grader = { schema: 'paideia.grader.v1', id: 'g', golden: 'labels.yaml', calibration: 'c.json',
    context: { evidence: { description: 'Evidence' } }, teachers: [{ id: 't', provider: 'grok', model: 'm' }],
    model: { backend: 'teacher', teacher: 't' }, escalate: { to: 't', between: [0.2, 0.8] },
    questions: [{ id: 'q', type: 'yes-no', expected: 'yes', reads: ['output.body', 'context.evidence'] },
      { id: 'q2', type: 'yes-no', expected: 'no', reads: ['output.body', 'context.evidence'] }], score: { method: 'weighted' } };
  const manifest = { schema: 'paideia.grader-inputs.v1', items: [
    { id: 'a', lineage: 'a', example: { dataset: 'train', id: 'example' }, output: { from: 'out.json' }, context: { evidence: { from: 'evidence.md' } } },
    { id: 'b', lineage: 'b', output: { from: 'out.json' }, context: { evidence: { from: 'evidence.md' } } },
  ] };
  const graderFile = path.join(dir, 'grader.yaml'), inputsFile = path.join(dir, 'inputs.yaml');
  await Promise.all([writeFile(graderFile, stringify(grader)), writeFile(inputsFile, stringify(manifest)),
    writeFile(path.join(dir, 'out.json'), JSON.stringify({ body: ['Hello'], secret: 'NEVER' })), writeFile(path.join(dir, 'evidence.md'), 'Evidence')]);
  return { dir, grader, manifest, graderFile, inputsFile, teachers: ['t'] };
}
function provider(generate: (request: InferenceRequest) => Promise<string> = async () => '{"q":"yes","q2":"no"}', modelBasis?: 'requested-assumption'): InferenceProvider {
  return { id: 'fake', capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
    generate: async request => ({ text: await generate(request), model: 'reported', modelBasis, usage: null, route: 'fake' }) };
}
async function saved(dir: string): Promise<Labels> { return parse(await readFile(path.join(dir, 'labels.yaml'), 'utf8')) as Labels; }

describe('teacher labeling runner', () => {
  it('groups calls, persists per-vote identity, content hashes and resumes without calls', async () => {
    const f = await fixture(); const prompts: string[] = [];
    const deps = { provider: () => provider(async r => { prompts.push(r.prompt); return '{"q":"yes","q2":"no"}'; }) };
    const result = await runLabel({ ...f, adjudication: 1 }, deps);
    expect(result).toMatchObject({ calls: 2, votes: 4, missing: 0 });
    expect(prompts.every(p => !p.includes('NEVER'))).toBe(true);
    const labels = await saved(f.dir);
    expect(labels.labels[0]!.provenance.t).toMatchObject({ votes: { q: { status: 'ok', attempts: [{ provider: 'grok', requested_model: 'm', reported_model: 'reported', cli: null }] } } });
    const loaded = await loadLabels(result.labelsFile, await loadGrader(f.graderFile));
    expect(loaded.labels.labels[0]!.output).toEqual({ body: ['Hello'], secret: 'NEVER' });
    expect(parse(await readFile(result.adjudicationFile!, 'utf8')).items).toHaveLength(1);
    expect(await runLabel(f, deps)).toMatchObject({ calls: 0, votes: 0 });
    expect(await runLabel({ ...f, relabel: true, limit: 1 }, deps)).toMatchObject({ calls: 1, votes: 2 });
  });
  it('repairs once, counts invalid votes missing, and retains disputes', async () => {
    const f = await fixture(); let calls = 0;
    const result = await runLabel({ ...f, limit: 1, adjudication: 0 }, { provider: () => provider(async r => {
      calls++; if (calls === 2) expect(r.prompt).toContain('previous response failed'); return '{}';
    }, 'requested-assumption') });
    expect(result).toMatchObject({ calls: 2, votes: 0, missing: 2 });
    const labels = await saved(f.dir);
    expect(labels.labels[0]!.votes).toEqual({ q: {}, q2: {} });
    expect(labels.labels[0]!.provenance.t).toMatchObject({ votes: { q: { attempts: [{ reported_model: null }, { reported_model: null }] } } });
    expect(parse(await readFile(result.adjudicationFile!, 'utf8')).items).toHaveLength(2);
    let n = 0;
    expect(await runLabel({ ...f, limit: 1 }, { provider: () => provider(async () => {
      if (n++ === 0) throw new InferenceFailure('invalid-response', 'bad schema');
      return '{"q":"yes","q2":"no"}';
    }) })).toMatchObject({ calls: 2, votes: 2 });
  });
  it('does not retry transport errors and enforces cancellation and subscription', async () => {
    const f = await fixture();
    expect(await runLabel({ ...f, limit: 1 }, { provider: () => provider(async () => { throw new Error('transport'); }) })).toMatchObject({ calls: 1, missing: 2 });
    const api = provider(); api.capabilities.billing = 'api';
    await expect(runLabel({ ...f, relabel: true }, { provider: () => api })).rejects.toThrow('subscription');
    const controller = new AbortController(); controller.abort();
    await expect(runLabel({ ...f, signal: controller.signal }, { provider: () => provider() })).rejects.toThrow();
    const controller2 = new AbortController();
    await expect(runLabel({ ...f, limit: 1, signal: controller2.signal }, { provider: () => provider(async () => { controller2.abort(); throw new Error(); }) })).rejects.toThrow();
  });
  it('refuses stale votes and content unless explicitly relabelled', async () => {
    const f = await fixture(); const deps = { provider: () => provider() }; await runLabel(f, deps);
    await writeFile(path.join(f.dir, 'out.json'), '{"body":["Changed"]}');
    await expect(runLabel(f, deps)).rejects.toThrow('Stale content');
    expect(await runLabel({ ...f, relabel: true }, deps)).toMatchObject({ calls: 2 });
    f.grader.questions[0]!.expected = 'no'; await writeFile(f.graderFile, stringify(f.grader));
    await expect(runLabel(f, deps)).rejects.toThrow('Stale vote');
    await runLabel({ ...f, relabel: true }, deps);
    const labels = await saved(f.dir); labels.labelers.t = { kind: 'human', name: 'H' };
    await writeFile(path.join(f.dir, 'labels.yaml'), stringify(labels));
    await expect(runLabel(f, deps)).rejects.toThrow('collides');
    await writeFile(path.join(f.dir, 'labels.yaml'), 'bad');
    await expect(runLabel(f, deps)).rejects.toThrow();
  });
  it('bounds parallel calls and validates command controls', async () => {
    const f = await fixture(); let active = 0, maximum = 0;
    const deps = { provider: () => provider(async () => { active++; maximum = Math.max(active, maximum); await new Promise(resolve => setTimeout(resolve, 5)); active--; return '{"q":"yes","q2":"no"}'; }) };
    await runLabel({ ...f, concurrency: 1 }, deps); expect(maximum).toBe(1);
    for (const change of [{ concurrency: 0 }, { limit: 0 }, { adjudication: -1 }, { concurrency: 1.5 }]) await expect(runLabel({ ...f, ...change }, deps)).rejects.toThrow('Invalid');
    for (const teachers of [[], ['t', 't'], ['unknown']]) await expect(runLabel({ ...f, teachers }, deps)).rejects.toThrow();
  });

  it('preserves matching partial votes and relabels changed option declarations', async () => {
    const f = await fixture(); const deps = { provider: () => provider() }; await runLabel({ ...f, limit: 1 }, deps);
    const labels = await saved(f.dir);
    delete labels.labels[0]!.votes.q2!.t;
    labels.labels[0]!.asked = undefined;
    labels.labels[0]!.votes.q!.t = 'no';
    await writeFile(path.join(f.dir, 'labels.yaml'), stringify(labels));
    await runLabel({ ...f, limit: 1 }, { provider: () => provider(async request => {
      expect(JSON.parse(request.prompt).questions).toHaveLength(1);
      return '{"q2":"no"}';
    }) });
    expect((await saved(f.dir)).labels[0]!.votes.q!.t).toBe('no');
    const changed = { ...f.grader, questions: [{ id: 'new', type: 'choice', options: ['a', 'b'], expected: ['a'], reads: ['output.body'] }] };
    await writeFile(f.graderFile, stringify(changed));
    await runLabel({ ...f, relabel: true, limit: 1 }, { provider: () => provider(async () => '{"new":"a"}') });
    expect((await saved(f.dir)).labels[0]!.votes).toEqual({ new: { t: 'a' } });
    await writeFile(path.join(f.dir, 'labels.yaml'), 'schema: [');
    await expect(runLabel({ ...f, relabel: true }, deps)).rejects.toThrow('Invalid labels YAML');
    labels.grader = 'wrong'; await writeFile(path.join(f.dir, 'labels.yaml'), stringify(labels));
    await expect(runLabel({ ...f, relabel: true }, deps)).rejects.toThrow('mismatch');
  });
  it('checks saved references outside the current input manifest and projection digests after readdressing', async () => {
    const f = await fixture();
    await writeFile(path.join(f.dir, 'other.json'), '{"body":["Original"]}');
    f.manifest.items[1]!.output.from = 'other.json';
    await writeFile(f.inputsFile, stringify(f.manifest));
    const deps = { provider: () => provider() };
    await runLabel(f, deps);
    await writeFile(path.join(f.dir, 'other.json'), '{"body":["Edited"]}');
    await expect(runLabel({ ...f, limit: 1 }, deps)).rejects.toThrow('sha256 mismatch');
    const labels = await saved(f.dir);
    const incoming = await loadLabelInputs(f.inputsFile, await loadGrader(f.graderFile));
    labels.labels[1]!.output = incoming[1]!.label.output;
    await writeFile(path.join(f.dir, 'labels.yaml'), stringify(labels));
    await expect(runLabel({ ...f, limit: 1 }, deps)).rejects.toThrow('Stale vote');
    labels.labels[1]!.output = null;
    labels.labels[1]!.context = { text: 'inline', array: [], object: { value: 1 } };
    const resolved = await resolveStoredLabels(labels, path.join(f.dir, 'labels.yaml'));
    expect(resolved.labels[1]!.output).toBeNull();
    expect(resolved.labels[1]!.context).toEqual(labels.labels[1]!.context);
  });
  it('repairs duplicate JSON keys before accepting teacher answers', async () => {
    const f = await fixture(); let calls = 0;
    const result = await runLabel({ ...f, limit: 1 }, { provider: () => provider(async () =>
      calls++ === 0 ? '{"q":"no","q":"yes","q2":"no"}' : '{"q":"yes","q2":"no"}') });
    expect(result).toMatchObject({ calls: 2, votes: 2 });
    expect((await saved(f.dir)).labels[0]!.provenance.t).toMatchObject({ votes: { q: { instance_keys: ['q', 'q2'] } } });
  });
  it('builds subscription providers and rejects unsupported effort', () => {
    expect(createGraderTeacher({ id: 't', provider: 'claude', model: 'm' }).id).toBe('claude-subscription');
    expect(createGraderTeacher({ id: 't', provider: 'grok', model: 'm', effort: 'high' }, 100).id).toBe('grok-subscription');
    expect(createGraderTeacher({ id: 't', provider: 'grok', model: 'm' }).id).toBe('grok-subscription');
    expect(() => createGraderTeacher({ id: 't', provider: 'grok', model: 'm', effort: 'bad' })).toThrow('effort');
    expect(() => createGraderTeacher({ id: 't', provider: 'claude', model: 'm', effort: 'high' })).toThrow('effort');
  });
  it('validates manifest structure, uniqueness and context, and accepts omitted context', async () => {
    const f = await fixture(); const g = await loadGrader(f.graderFile);
    await writeFile(f.inputsFile, 'schema: ['); await expect(loadLabelInputs(f.inputsFile, g)).rejects.toThrow('YAML');
    await writeFile(f.inputsFile, stringify({ ...f.manifest, items: [f.manifest.items[0], structuredClone(f.manifest.items[0])] }));
    await expect(loadLabelInputs(f.inputsFile, g)).rejects.toThrow('Duplicate');
    await writeFile(f.inputsFile, stringify({ ...f.manifest, items: [{ ...f.manifest.items[0], context: { unknown: { from: 'evidence.md' } } }] }));
    await expect(loadLabelInputs(f.inputsFile, g)).rejects.toThrow('Undeclared');
    await writeFile(f.inputsFile, stringify({ ...f.manifest, items: [{ id: 'raw', lineage: 'raw', output: { from: 'evidence.md' } }] }));
    expect((await loadLabelInputs(f.inputsFile, g))[0]!.output).toBe('Evidence');
  });
});
