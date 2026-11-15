import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateComponents, deriveCandidate, snapshotCandidate } from '../candidates/index.js';
import { parseDatasetYaml, resolveDataset } from '../cases/index.js';
import type { InferenceProvider } from '../contracts/execution.js';
import type { DspyResult } from '../optimization/index.js';
import { criticIdentity, criticSelection, describeChecks, rankedCandidates, trainCaseTexts } from './selection.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const train = resolveDataset(parseDatasetYaml(JSON.stringify({ schema: 'spawnfile.training.dataset.v1', id: 'train',
  records: [{ id: 'landtag', group: 'a', input: { prompt: 'AfD nominated Tobias Rausch; who holds the gavel.' }, outputs: { article: 'a.json' },
    stages: [{ id: 's', checks: [{ id: 'length', eval: 'word-count', input: 'artifact:article#/body', min: 200, max: 400 },
      { id: 'quality', eval: 'llm-rubric', input: 'artifact:article', judge: 'strong', rubric: { prompt: 'SECRET RUBRIC' }, minimum: 0.5 },
      { id: 'both', all: [{ id: 'shape', eval: 'json-schema', input: 'artifact:article', schema: { type: 'object' } }, { not: { eval: 'equals', input: 'output.text', value: 'x' } }] }],
      gate: { all: [{ passed: 'length' }, { passed: 'quality' }, { passed: 'both' }] } }] },
  { id: 'turns', group: 'b', turns: [{ id: 't', input: { prompt: 'First' } }], checks: [{ id: 'done', eval: 'equals', input: 'output.text', value: 'y' }] }] }), { sourceName: '/p/d.yaml' }), { registry: { judges: { strong: { version: '1' } } } });

async function fixture(replies: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), 'critic-')); roots.push(root);
  await writeFile(join(root, 'AGENTS.md'), 'Report only what the rows state.\n');
  const baseline = await snapshotCandidate({ sourceRoot: root, resources: [{ id: 'instructions', sourcePath: 'AGENTS.md', destinations: [{ kind: 'instructions', path: 'AGENTS.md' }], edit: 'whole-file' }] });
  const id = candidateComponents(baseline)[0]!.id;
  const components = (text: string) => ({ [id]: text });
  const prompts: string[] = [];
  const provider: InferenceProvider = { id: 'p', capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
    async generate(request) { prompts.push(request.prompt); return { text: JSON.stringify(replies.shift()), model: 'm', usage: null, route: 'r' }; } };
  const quota = 'Report only what the rows state.\nWrite a body of 200 to 400 words.\n', plain = 'Report only what the rows state.\nName the country.\n';
  const optimizer = { components: components(quota), provenance: { candidates: [
    { components: components('Report only what the rows state.\n'), validationScore: 0.6 }, { components: components(plain), validationScore: 0.7 },
    { components: components(quota), validationScore: 0.9 }] } } as unknown as DspyResult;
  const candidateFor = (value: Readonly<Record<string, string>>) => value[id] === 'Report only what the rows state.\n' ? baseline : deriveCandidate(baseline, baseline, value);
  const critic = { judge: { name: 'strong', provider, model: 'm' }, guide: [{ name: 'WRITING.md', text: 'Length follows the facts.' }], show: { checks: true, trainTasks: true }, blockOn: 'high' as const };
  return { baseline, optimizer, candidateFor, critic, prompts, quota: candidateFor(components(quota)), plain: candidateFor(components(plain)) };
}
const block = { summary: 'quota', findings: [{ category: 'check_only_rule', quoted_line: 'Write a body of 200 to 400 words.', guide_ref: '', why: 'No guide basis.', severity: 'high' }] };

describe('critic selection', () => {
  it('removes a blocked search winner and selects the next candidate that passes', async () => {
    const { baseline, optimizer, candidateFor, critic, prompts, quota, plain } = await fixture([block, { summary: 'fine', findings: [] }]);
    const gate = await criticSelection({ critic, baseline, train, optimizer, candidateFor });
    expect(gate.selected.id).toBe(plain.id);
    expect(gate.report).toMatchObject({ selectedId: plain.id, displacedId: quota.id,
      reviews: [{ candidateId: quota.id, validationScore: 0.9, selected: false, review: { verdict: 'block' } }, { candidateId: plain.id, validationScore: 0.7, selected: true }] });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('--- case landtag ---\nAfD nominated Tobias Rausch; who holds the gavel.');
    expect(prompts[0]).toContain('- length: word-count min 200, max 400');
    expect(prompts[0]).not.toContain('SECRET RUBRIC');
  });
  it('keeps the baseline when every changed candidate is blocked and shows only what the run declares', async () => {
    const { baseline, optimizer, candidateFor, critic, prompts } = await fixture([block, { summary: 'x', findings: [{ ...block.findings[0]!, quoted_line: 'Name the country.' }] }]);
    const gate = await criticSelection({ critic: { ...critic, show: { checks: false, trainTasks: false } }, baseline, train, optimizer, candidateFor });
    expect(gate.selected.id).toBe(baseline.id);
    expect(gate.report.reviews).toHaveLength(2);
    expect(prompts[0]).not.toMatch(/TRAIN CASES|DECLARED CHECKS/u);
  });
  it('describes checks without judged question text and reads train tasks from every input shape', () => {
    expect(describeChecks(train)).toBe(['- length: word-count min 200, max 400',
      '- quality: llm-rubric (a model answers fixed questions about the output; question text is withheld)', '- shape: json-schema', '- equals: equals value "x"', '- done: equals value "y"'].join('\n'));
    expect(trainCaseTexts(train)).toEqual([{ id: 'landtag', text: 'AfD nominated Tobias Rausch; who holds the gavel.' }, { id: 'turns', text: JSON.stringify(train.records[1]!.turns) }]);
  });
  it('ranks the search\'s choice first, reuses a kept review and binds a review to what the critic was shown', async () => {
    const { baseline, optimizer, candidateFor, critic, prompts, quota, plain } = await fixture([]);
    expect(rankedCandidates(optimizer, candidateFor).map(entry => [entry.candidate.id, entry.validationScore])).toEqual([[quota.id, 0.9], [quota.id, 0.9], [plain.id, 0.7], [baseline.id, 0.6]]);
    expect(rankedCandidates({ components: optimizer.components, provenance: { candidates: [] } } as never, candidateFor)).toEqual([{ candidate: quota, validationScore: null }]);
    const seen: [string, boolean][] = [];
    const kept = { verdict: 'pass' as const, blockOn: 'high' as const, summary: 'kept', findings: [], overlaps: [] };
    const gate = await criticSelection({ critic, baseline, train, optimizer, candidateFor, reviewed: { [quota.id]: kept }, onReview: (id, _review, restored) => { seen.push([id, restored]); } });
    expect(gate.selected.id).toBe(quota.id);
    expect(prompts).toHaveLength(0);
    expect(seen).toEqual([[quota.id, true]]);
    const shown = criticIdentity(critic, baseline, train);
    expect(criticIdentity(critic, baseline, train)).toBe(shown);
    for (const other of [{ ...critic, show: { checks: false, trainTasks: true } }, { ...critic, show: { checks: true, trainTasks: false } }, { ...critic, blockOn: 'low' as const }, { ...critic, guide: [] }]) {
      expect(criticIdentity(other, baseline, train)).not.toBe(shown);
    }
  });
});
