import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { InferenceFailure } from '../../../inference/index.js';
import { stableDigest } from '../../../graders/index.js';
import { fixture, redundancyFixture } from './fixtures.js';
import { runDecompose, runReference, runTraps } from './index.js';

async function load(directory: string, suffix: string) {
  const name = (await readdir(directory)).find(file => file.endsWith(suffix))!;
  return JSON.parse(await readFile(join(directory, name), 'utf8'));
}
it('persists rejected real spans, refuses downstream by default and counts allowed rejections as missing checks', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'output.json'), JSON.stringify({ body: ['Alice reported 12 items. [R9]'] }));
  expect(await runDecompose(f.decompose, f.dependencies)).toMatchObject({ rejected: 1 });
  const doc = await load(f.decompose.out, '.decomposition.json');
  expect(doc.rejected).toMatchObject([{ id: 'x1', reasons: ['unknown cited row'], unit: { text: f.unit.text } }]);
  const report = await load(f.decompose.out, '.instantiation.json');
  expect(report.checks).toMatchObject([{ id: 'rejected@x1', status: 'missing' }]);
  await expect(runTraps(f.traps)).rejects.toThrow('--allow-rejections');
  await expect(runReference({ ...f.reference, traps: undefined }, f.dependencies)).rejects.toThrow('--allow-rejections');
  expect(await runTraps({ ...f.traps, allowRejections: true })).toMatchObject({ missingChecks: 1 });
  const result = await runReference({ ...f.reference, allowRejections: true }, f.dependencies);
  expect(result).toMatchObject({ gate: 'STOP', coverage: { missingChecks: 1 }, instability: { items: 0 } });
  expect(await readFile(result.reportFile, 'utf8')).toContain('Rejected units counted as missing checks: 1');
  expect(await runDecompose(f.decompose, f.dependencies)).toMatchObject({ resumed: 1, rejected: 1 });
});
it.each([true, false])('records provider schema failure class and available protected diagnostic (%s), then retries', async diagnosticAvailable => {
  const f = await fixture();
  const diagnostic = { code: 'response-schema' as const, response: { bytes: 3, sha256: 'sha256:digest', text: 'bad', omitted: false } };
  f.generate.mockRejectedValueOnce(new InferenceFailure('protocol', 'private provider prose', diagnosticAvailable ? { diagnostic } : {}));
  await expect(runDecompose(f.decompose, f.dependencies)).rejects.toThrow('private provider prose');
  const saved = await load(f.decompose.out, '.checkpoint.json');
  expect(saved.receipts[0]).toMatchObject({ failure_class: 'protocol', outcome: 'invalid-response' });
  expect(saved.receipts[0].diagnostic).toEqual(diagnosticAvailable ? diagnostic : undefined);
  expect(JSON.stringify(saved)).not.toContain('private provider prose');
  expect(await runDecompose(f.decompose, f.dependencies)).toMatchObject({ completed: 1 });
  expect(f.generate).toHaveBeenCalledTimes(3);
  expect((await load(f.decompose.out, '.checkpoint.json')).receipts).toHaveLength(3);
});
it('excludes cancelled calls from report totals while preserving run receipts', async () => {
  const f = await fixture();
  await runDecompose(f.decompose, f.dependencies);
  f.generate.mockImplementation(async request => ({ text: '{"q1":{"answer":"supported"}}', model: request.model, route: 'subscription', usage: null }));
  const result = await runReference({ ...f.reference, traps: undefined }, f.dependencies);
  const directory = `${f.reference.out}.checkpoints`;
  const name = (await readdir(directory))[0]!;
  const saved = JSON.parse(await readFile(join(directory, name), 'utf8'));
  saved.calls.push({ ...saved.calls[0], outcome: 'cancelled', wallMs: 1_000_000 });
  const { digest: _digest, ...content } = saved;
  await writeFile(join(directory, name), JSON.stringify({ ...content, digest: stableDigest(content) }));
  await runReference({ ...f.reference, traps: undefined }, f.dependencies);
  const report = await readFile(result.reportFile, 'utf8');
  expect(report).toContain('Calls: 2;');
  expect(report).toContain('codex: 2 calls; input tokens: 0 reported; 2 calls unknown;');
  expect(report).toContain('including adjudication, failed/cancelled calls');
  expect(Number(/recorded latency: (\d+)/.exec(report)![1])).toBeLessThan(1_000_000);
  expect((await load(directory, '.json')).calls).toHaveLength(3);
});
it('binds trap generation to current completed base references and rejects missing or corrupt artifacts', async () => {
  const f = await fixture();
  await runDecompose(f.decompose, f.dependencies);
  const references = join(f.root, 'base.json');
  await expect(runTraps({ ...f.traps, references })).rejects.toThrow('Missing base');
  await writeFile(references, JSON.stringify({ digest: 'bad' }));
  await expect(runTraps({ ...f.traps, references })).rejects.toThrow('corrupt');
  f.generate.mockImplementation(async request => ({ text: '{"q1":{"answer":"unsupported"}}', model: request.model, route: 'subscription', usage: null }));
  await runReference({ ...f.reference, traps: undefined, out: references }, f.dependencies);
  expect(await runTraps({ ...f.traps, references })).toMatchObject({ generated: 1 });
  const artifact = JSON.parse(await readFile(references, 'utf8'));
  for (const output of Object.values(artifact.outputs) as { complete: boolean }[]) output.complete = false;
  const { digest: _digest, ...content } = artifact;
  await writeFile(references, JSON.stringify({ ...content, digest: stableDigest(content) }));
  await expect(runTraps({ ...f.traps, references })).rejects.toThrow('incomplete');
});

it.each(['placeholder', 'condition', 'null-final'])('stops %s base checks despite perfect traps on another check', async mode => {
  const f = await redundancyFixture();
  const extra = { ...f.templates.templates[0]!, id: 'actor', traps: {} };
  if (mode === 'placeholder') extra.instructions = 'Check {unit.fields.object}';
  const templates = { ...f.templates, templates: [...f.templates.templates,
    { ...extra, ...(mode === 'condition' ? { when: { field: 'object', equals: 'items' } } : {}) }] };
  await writeFile(f.templatesFile, JSON.stringify(templates));
  await runDecompose(f.decompose, f.dependencies);
  f.generate.mockImplementation(async request => {
    const prompt = JSON.parse(request.prompt);
    const answers = prompt.questions.map((question: { key: string; evidence?: { neighbors: { next: string } } }) => {
      const text = (prompt.projection ?? question.evidence).neighbors.next as string;
      return [question.key, { answer: question.key === 'q2'
        ? request.system!.includes('Adversarially') ? 'uncertain' : 'abstain' : text.includes('12') ? 'unsupported' : 'supported' }];
    });
    return { text: JSON.stringify(Object.fromEntries(answers)), model: request.model, route: 'subscription', usage: null };
  });
  await runReference({ ...f.reference, traps: undefined }, f.dependencies);
  await runTraps({ ...f.traps, references: f.reference.out });
  const result = await runReference(f.reference, f.dependencies);
  expect(result).toMatchObject({ gate: 'STOP', coverage: { covered: 1, missingChecks: 0 },
    knownAnswer: { accuracy: 1 }, consistency: { accuracy: 1 },
    completeness: { total: 2, missing: 1, rate: 0.5, byTemplate: { actor: { total: 1, missing: 1 } } } });
  const artifact = JSON.parse(await readFile(result.file, 'utf8'));
  expect(artifact.quality.completeness).toEqual(result.completeness);
  const report = await readFile(result.reportFile, 'utf8');
  expect(report).toContain('Missing base checks: 50.00% (1/2); required <= 0%.');
  expect(report).toContain('Missing base checks for template actor: 1/1.');
  expect(report).toContain(`Missing base checks for output ${Object.keys(result.completeness.byOutput)[0]}: 1/2.`);
});

it('reports council provider failure classes and persists protected evidence without provider prose', async () => {
  const f = await fixture();
  await runDecompose(f.decompose, f.dependencies);
  const diagnostic = { code: 'response-schema' as const, response: { bytes: 3, sha256: 'sha256:digest', text: 'bad', omitted: false } };
  f.generate.mockRejectedValue(new InferenceFailure('invalid-response', 'private provider prose', { diagnostic }));
  const result = await runReference({ ...f.reference, traps: undefined }, f.dependencies);
  const saved = await load(`${f.reference.out}.checkpoints`, '.json');
  expect(saved.calls).toHaveLength(4);
  for (const call of saved.calls) expect(call).toMatchObject({ failure_class: 'invalid-response', diagnostic });
  const report = await readFile(result.reportFile, 'utf8');
  expect(report.match(/Failed council call/g)).toHaveLength(4);
  expect(report).toContain('invalid-response; 1 checks affected.');
  expect(report).not.toContain('sha256:digest');
  expect(JSON.stringify(saved) + report).not.toContain('private provider prose');
});
