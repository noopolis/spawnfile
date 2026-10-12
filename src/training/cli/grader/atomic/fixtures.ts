import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, vi } from 'vitest';
import { stringify } from 'yaml';
import type { InferenceProvider } from '../../../contracts/execution.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
export async function fixture(trapKind: 'format-paraphrase' | 'injected-redundancy' = 'format-paraphrase') {
  const root = await mkdtemp(join(tmpdir(), 'atomic-cli-')); roots.push(root);
  const templates = { schema: 'paideia.check-templates.v1', templates: [{ id: 'support', applies_to: 'claim', type: 'choice',
    instructions: 'Is {unit.text} supported?', criteria: { supported: 'Supported', unsupported: 'Unsupported' },
    expected: ['supported'], state: ['unit', 'unit.cited_rows'], dimension: 'facts', severity: 'major',
    traps: { [trapKind]: trapKind === 'format-paraphrase' ? 'unchanged' : 'unsupported', 'option-permutation': 'unchanged' } as Record<string, string> }],
    context: { evidence: { rows: { leading_citations: 'previous', heading: '^## ([A-Z][0-9]+)', cite: '\\[([A-Z][0-9]+)\\]' } } },
    teachers: [{ id: 'codex', provider: 'codex', model: 'test-codex' }, { id: 'claude', provider: 'claude', model: 'test-claude' },
      { id: 'grok', provider: 'grok', model: 'test-grok' }] };
  const templatesFile = join(root, 'templates.yaml'), inputsFile = join(root, 'inputs.yaml');
  await writeFile(templatesFile, stringify(templates));
  await writeFile(join(root, 'output.json'), JSON.stringify({ body: ['Alice reported 12 items. [A1]'] }));
  await writeFile(join(root, 'evidence.md'), '## A1\nAlice reported 12 items.\n## B2\nBob reported 5 items.\n');
  const items = [{ id: 'one', lineage: 'one', output: { from: 'output.json' }, context: { evidence: { from: 'evidence.md' } } }];
  await writeFile(inputsFile, stringify({ schema: 'paideia.grader-inputs.v1', items }));
  const unit = { id: 'claim', kind: 'claim', text: 'Alice reported 12 items.', paragraph: 0, sentence: 0,
    cites: ['A1'], fields: { actor: 'Alice', quantity: '12' } };
  const generate = vi.fn<InferenceProvider['generate']>(async request => {
    const prompt = JSON.parse(request.prompt) as { task?: string; questions?: Record<string, unknown> };
    return { text: JSON.stringify({ units: prompt.task?.startsWith('Independently') ? [] : [unit] }), model: request.model, route: 'subscription', usage: null };
  });
  const provider: InferenceProvider = { id: 'fake', capabilities: { tools: 'contained', billing: 'subscription', temperature: false, seed: false }, generate };
  const dependencies = { provider: () => provider };
  return { root, templates, templatesFile, inputsFile, unit, items, generate, provider, dependencies,
    decompose: { templatesFile, inputsFile, extractors: ['codex', 'claude'], out: join(root, 'decompositions') },
    traps: { templatesFile, decompositions: join(root, 'decompositions'), out: join(root, 'traps') },
    reference: { templatesFile, decompositions: join(root, 'decompositions'), traps: join(root, 'traps'), teachers: ['codex', 'claude'],
      out: join(root, 'references.json'), now: new Date('2026-10-11T12:00:00Z') } };
}


/** Visible repetition supplies the remaining known-answer defect control. */
export async function redundancyFixture() {
  const f = await fixture('injected-redundancy');
  f.templates.templates[0]!.state.push('neighbors');
  await writeFile(f.templatesFile, JSON.stringify(f.templates));
  await writeFile(join(f.root, 'output.json'), JSON.stringify({ body: [`${f.unit.text} [A1]`, 'Next paragraph.'] }));
  return f;
}
