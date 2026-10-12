import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { stringify } from 'yaml';
import { stableDigest } from '../../../graders/index.js';
import { runDecompose, selectTeachers } from './decompose.js';
import { readInputs, readTemplates } from './files.js';
import { fixture } from './fixtures.js';

async function checkpoint(f: Awaited<ReturnType<typeof fixture>>) {
  const file = join(f.decompose.out, (await readdir(f.decompose.out)).find(name => name.endsWith('.checkpoint.json'))!);
  return { file, value: JSON.parse(await readFile(file, 'utf8')) };
}

it('allowlists both extraction and audit prompts, retaining declarations but no answer keys', async () => {
  const f = await fixture();
  await writeFile(f.templatesFile, stringify({ ...f.templates,
    kinds: { claim: 'Factual assertion' },
    context: { ...f.templates.context, brief: { role: 'assignment', description: 'SECRET_CONTEXT_DESCRIPTION' } },
    templates: [{ ...f.templates.templates[0], id: 'SECRET_ID', instructions: 'SECRET_INSTRUCTIONS',
      criteria: { SECRET_YES: 'SECRET_CRITERION', SECRET_NO: 'SECRET_OTHER_CRITERION' },
      expected: ['SECRET_YES'], dimension: 'SECRET_DIMENSION', severity: 'critical',
      traps: { 'injected-redundancy': 'SECRET_NO' }, locations: ['body'],
      when: { field: 'quantity', equals: 'SECRET_CONDITION_VALUE' } }] }));
  await runDecompose(f.decompose, f.dependencies);
  expect(f.generate).toHaveBeenCalledTimes(2);
  for (const [request] of f.generate.mock.calls) {
    expect(request.prompt).not.toMatch(/SECRET_|expected|criteria|traps|dimension|severity|instructions|injected-redundancy/);
    expect(JSON.parse(request.prompt)).toMatchObject({
      kinds: ['claim'], kind_descriptions: { claim: 'Factual assertion' },
      templates: [{ applies_to: 'claim', locations: ['body'], when: { field: 'quantity' } }],
      context_definitions: { evidence: f.templates.context.evidence, brief: { role: 'assignment' } },
    });
    expect(Object.keys(JSON.parse(request.prompt).templates[0]).sort()).toEqual(['applies_to', 'locations', 'when']);
  }
});

it.each(['expected', 'criteria', 'traps', 'instructions', 'dimension', 'severity', 'id', 'state', 'when.equals', 'context.description'])(
'reuses completed extraction identity after editing only %s', async field => {
  const f = await fixture();
  const templates = await readTemplates(f.templatesFile);
  templates.templates[0]!.when = { field: 'quantity', equals: '12' };
  await writeFile(f.templatesFile, stringify(templates));
  await runDecompose(f.decompose, f.dependencies);
  const before = (await checkpoint(f)).value;
  const template = templates.templates[0]!;
  switch (field) {
    case 'expected': template.expected = ['unsupported']; break;
    case 'criteria': template.criteria.supported = 'Different grading criterion'; break;
    case 'traps': template.traps!['injected-redundancy'] = { answer: 'supported', known_answer: false }; break;
    case 'instructions': template.instructions = 'Different grading instruction'; break;
    case 'dimension': template.dimension = 'different'; break;
    case 'severity': template.severity = 'minor'; break;
    case 'id': template.id = 'renamed'; break;
    case 'state': template.state = ['unit']; break;
    case 'when.equals': template.when!.equals = 'other'; break;
    case 'context.description': templates.context.evidence!.description = 'Different grading context description'; break;
  }
  await writeFile(f.templatesFile, stringify(templates));
  expect(await runDecompose(f.decompose, f.dependencies)).toMatchObject({ completed: 1, resumed: 1 });
  expect((await checkpoint(f)).value).toEqual(before);
  expect(f.generate).toHaveBeenCalledTimes(2);
  if (field === 'expected') {
    const file = (await readdir(f.decompose.out)).find(name => name.endsWith('.instantiation.json'))!;
    const report = JSON.parse(await readFile(join(f.decompose.out, file), 'utf8'));
    expect(report.checks[0].expected).toEqual(['unsupported']);
  }
});

it('reuses extraction after an audit failure and grading-only edits', async () => {
  const f = await fixture();
  const response = await f.generate({ model: 'test', system: '', prompt: '{}' });
  f.generate.mockClear();
  f.generate.mockResolvedValueOnce(response).mockRejectedValueOnce(new Error('audit unavailable'));
  await expect(runDecompose(f.decompose, f.dependencies)).rejects.toThrow('audit unavailable');
  const before = (await checkpoint(f)).value;
  await writeFile(f.templatesFile, stringify({ ...f.templates, templates: [{ ...f.templates.templates[0],
    expected: ['unsupported'], criteria: { supported: 'New rubric', unsupported: 'New negative rubric' },
    traps: { 'injected-redundancy': 'supported' } }] }));
  expect(await runDecompose(f.decompose, f.dependencies)).toMatchObject({ completed: 1 });
  const after = (await checkpoint(f)).value;
  expect(after.identity).toBe(before.identity);
  expect(after.receipts[0]).toEqual(before.receipts[0]);
  expect(f.generate).toHaveBeenCalledTimes(3);
  expect(JSON.parse(f.generate.mock.calls[2]![0].prompt).task).toMatch(/^Independently audit/);
});

it.each(['kinds', 'kind description', 'applies_to', 'locations', 'when.field', 'context.rows', 'context.role'])(
'invalidates extraction identity after editing %s', async field => {
  const f = await fixture();
  const templates = await readTemplates(f.templatesFile);
  templates.kinds = { claim: 'Factual assertion' };
  templates.templates[0]!.when = { field: 'quantity', equals: '12' };
  await writeFile(f.templatesFile, stringify(templates));
  await runDecompose(f.decompose, f.dependencies);
  const before = (await checkpoint(f)).value;
  switch (field) {
    case 'kinds': templates.kinds.display = 'Display text'; break;
    case 'kind description': templates.kinds.claim = 'Different definition'; break;
    case 'applies_to': templates.templates[0]!.applies_to = 'display'; break;
    case 'locations': templates.templates[0]!.locations = ['headline']; break;
    case 'when.field': templates.templates[0]!.when!.field = 'actor'; break;
    case 'context.rows': templates.context.evidence!.rows!.heading = '^## ([A-Z][0-9]+)$'; break;
    case 'context.role': templates.context.evidence!.role = 'assignment'; break;
  }
  await writeFile(f.templatesFile, stringify(templates));
  await expect(runDecompose(f.decompose, f.dependencies)).rejects.toThrow('Stale decomposition checkpoint');
  expect((await checkpoint(f)).value).toEqual(before);
  expect(f.generate).toHaveBeenCalledTimes(2);
});

it('refuses v7 checkpoints before making new calls', async () => {
  const f = await fixture();
  await runDecompose(f.decompose, f.dependencies);
  const templates = await readTemplates(f.templatesFile);
  const [input] = await readInputs(f.inputsFile, templates);
  const { file, value } = await checkpoint(f);
  const { digest: _digest, ...content } = value;
  content.identity = stableDigest({ refs: input!.refs, templates, teachers: selectTeachers(templates, f.decompose.extractors),
    protocol: 'paideia.extraction.v7' });
  await writeFile(file, JSON.stringify({ ...content, digest: stableDigest(content) }));
  await expect(runDecompose(f.decompose, f.dependencies)).rejects.toThrow('Stale decomposition checkpoint');
  expect(f.generate).toHaveBeenCalledTimes(2);
});
