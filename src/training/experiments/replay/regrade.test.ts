import { describe, expect, it } from 'vitest';
import { createEvaluationRegistry } from '../../evaluation/index.js';
import { testBankYaml, testJudge, testMaterial, testReplies } from '../../questionnaire/index.js';
import { regradeManifestSchema, regradeRecordedOutputs, type RegradedOutput } from './regrade.js';

const files: Record<string, string> = { 'bank.yaml': testBankYaml, 'clean.json': JSON.stringify(testMaterial.output), 'figure.json': JSON.stringify({ ...testMaterial.output, headline: 'Seven stations closed' }),
  'evidence.json': JSON.stringify(testMaterial.context.evidence), 'assignment.txt': testMaterial.context.assignment,
  'expect.json': JSON.stringify([{ id: 'variant', base: 'base-clean', defect: 'figure', targets: ['figures'], gate_must_fail: true }]) };
const context = { evidence: 'evidence.json', assignment: 'assignment.txt' };
const manifest = regradeManifestSchema.parse({ schema: 'spawnfile.training.regrade.v1',
  check: { id: 'house', eval: 'questionnaire', bank: 'bank.yaml', input: 'artifact:output', context: { evidence: 'context:evidence', assignment: 'context:assignment' } },
  judges: { strong: { provider: 'p', model: 'm', reasoning_effort: 'medium' } }, calibration: 'expect.json',
  outputs: [{ id: 'base-clean', candidate: 'baseline', case: 'c1', output: 'clean.json', context },
    { id: 'base-missing', candidate: 'baseline', case: 'c2', output: null, context },
    { id: 'cand-clean', candidate: 'candidate-1', case: 'c1', output: 'clean.json', context },
    { id: 'variant', candidate: 'calibration', case: 'c1', output: 'figure.json', calibration: true, context }] });
const failing = { ...testReplies[0]!, figures: { answer: 'no', reason: 'headline "Seven"' } };
const read = async (path: string) => { if (!Object.hasOwn(files, path)) throw new Error(`missing ${path}`); return files[path]!; };

describe('regrade of recorded outputs', () => {
  it('grades each output through the registered check, counts a missing output as zero and checks calibration', async () => {
    const strong = testJudge([testReplies[0], testReplies[1], testReplies[0], testReplies[1], failing, testReplies[1]]);
    const seen: RegradedOutput[] = [];
    const report = await regradeRecordedOutputs({ manifest, read, registry: createEvaluationRegistry(), evaluation: { judges: { strong } }, onResult: result => { seen.push(result); } });
    expect(strong.prompts).toHaveLength(6);
    expect(strong.prompts[4]).toContain('HEADLINE: Seven stations closed');
    expect(report).toMatchObject({ schema: 'spawnfile.training.regrade-report.v1', check: 'house', bank: { id: 'test-bank' }, judgeCalls: 6 });
    expect(report.candidates.baseline).toMatchObject({ outputs: 2, missing: 1, errors: 0, score: 0.3438, scoreOpen: 0.3334, scoreHidden: 0.375, gap: -0.0416, gatePassed: 1, graded: { outputs: 1, score: 0.6875 } });
    expect(report.candidates['candidate-1']).toMatchObject({ outputs: 1, missing: 0, score: 0.6875 });
    expect(Object.keys(report.candidates)).toEqual(['baseline', 'candidate-1']);
    expect(report.calibration).toMatchObject({ ok: true, caught: 1, gateFailed: 1, cleanBasesFailing: [] });
    expect(report.outputs.map(output => [output.id, output.status, output.score])).toEqual([['base-clean', 'pass', 0.6875], ['base-missing', 'fail', 0], ['cand-clean', 'pass', 0.6875], ['variant', 'fail', 0.4375]]);
    expect(report.outputs[0]).not.toHaveProperty('questionnaire');
    expect(seen.map(result => result.id)).toEqual(['base-clean', 'base-missing', 'cand-clean', 'variant']);
  });
  it('never asks again for a completed output and reports a judge that did not answer as an error', async () => {
    const first = await regradeRecordedOutputs({ manifest, read, registry: createEvaluationRegistry(),
      evaluation: { judges: { strong: testJudge([testReplies[0], testReplies[1], testReplies[0], testReplies[1], failing, testReplies[1]]) } }, onResult: () => undefined });
    expect(first.outputs).toHaveLength(4);
    const strong = testJudge([new Error('down'), testReplies[1]]);
    const completed: Record<string, RegradedOutput> = {};
    await regradeRecordedOutputs({ manifest, read, registry: createEvaluationRegistry(), evaluation: { judges: { strong: testJudge([testReplies[0], testReplies[1], testReplies[0], testReplies[1], failing, testReplies[1]]) } },
      onResult: result => { if (result.id !== 'cand-clean') completed[result.id] = result; } });
    const report = await regradeRecordedOutputs({ manifest, read, completed, registry: createEvaluationRegistry(), evaluation: { judges: { strong } } });
    expect(strong.prompts).toHaveLength(2);
    expect(report.outputs.find(output => output.id === 'cand-clean')).toMatchObject({ status: 'error' });
    expect(report.candidates['candidate-1']).toMatchObject({ errors: 1 });
    expect(report.bank.id).toBe('test-bank');
  });
  it('refuses an unfrozen sidecar, an invalid check and a cancelled run', async () => {
    const other = { ...manifest, check: { ...manifest.check, input: 'output.text' as never } };
    await expect(regradeRecordedOutputs({ manifest: other, read, registry: createEvaluationRegistry(), evaluation: { judges: {} } })).rejects.toThrow(/artifact selector/u);
    const controller = new AbortController();
    controller.abort();
    await expect(regradeRecordedOutputs({ manifest, read, registry: createEvaluationRegistry(), evaluation: { judges: {} }, signal: controller.signal })).rejects.toThrow();
    const none = { ...manifest, calibration: undefined, outputs: [manifest.outputs[1]!] };
    const report = await regradeRecordedOutputs({ manifest: none, read, registry: createEvaluationRegistry(), evaluation: { judges: {} } });
    expect(report.candidates.baseline).toMatchObject({ missing: 1, score: 0, gap: 0 });
    expect(report).not.toHaveProperty('calibration');
  });
  it('reviews recorded candidate prompts against the recorded baseline with the train case texts', async () => {
    const prompts: string[] = [];
    const replies: unknown[] = [{ summary: 'quota', findings: [{ category: 'check_only_rule', quoted_line: 'Write 200 to 400 words.', guide_ref: '', why: 'No guide basis.', severity: 'high' }] }, { summary: 'fine', findings: [] }];
    const strong = { ...testJudge([]), provider: { id: 'p', capabilities: { tools: 'disabled' as const, billing: 'subscription' as const, temperature: false, seed: false },
      generate: async (request: { prompt: string }) => { prompts.push(request.prompt); return { text: JSON.stringify(replies.shift()), model: 'm', usage: null, route: 'r' }; } } };
    const sources: Record<string, string> = { ...files, 'base.md': 'Report the rows.\n', 'one.md': 'Report the rows.\nWrite 200 to 400 words.\n', 'two.md': 'Report the rows.\nName the country.\n',
      'WRITING.md': 'Length follows the facts.', 'checks.txt': 'length: word-count 200 to 400', 'case.txt': 'AfD nominated Tobias Rausch.' };
    const reviewing = regradeManifestSchema.parse({ ...JSON.parse(JSON.stringify(manifest)), outputs: [], calibration: undefined, critic: { judge: 'strong', guide: ['docs/../WRITING.md'.replace('docs/../', '')], checks: 'checks.txt',
      train_cases: [{ id: 'landtag', file: 'case.txt' }], block_on: 'high', baseline: { 'AGENTS.md': 'base.md' }, candidates: { 'candidate-1': { 'AGENTS.md': 'one.md' }, 'candidate-2': { 'AGENTS.md': 'two.md' } } } });
    const seen: string[] = [];
    const options = { manifest: reviewing, read: async (path: string) => sources[path]!, registry: createEvaluationRegistry(), evaluation: { judges: { strong } } };
    const report = await regradeRecordedOutputs({ ...options, onReview: label => { seen.push(label); } });
    expect(report.critic).toMatchObject({ 'candidate-1': { verdict: 'block' }, 'candidate-2': { verdict: 'pass' } });
    expect(prompts[0]).toContain('--- case landtag ---\nAfD nominated Tobias Rausch.');
    expect(prompts[0]).toContain('length: word-count 200 to 400');
    expect(seen).toEqual(['candidate-1', 'candidate-2']);
    const again = await regradeRecordedOutputs({ ...options, reviewed: report.critic });
    expect(prompts).toHaveLength(2);
    expect(again.critic).toEqual(report.critic);
    const bare = regradeManifestSchema.parse({ ...JSON.parse(JSON.stringify(reviewing)), critic: { judge: 'strong', guide: ['WRITING.md'], baseline: { 'AGENTS.md': 'base.md' }, candidates: {} } });
    expect((await regradeRecordedOutputs({ ...options, manifest: bare })).critic).toEqual({});
    await expect(regradeRecordedOutputs({ ...options, evaluation: { judges: {} } })).rejects.toThrow('Critic judge strong has no configured route');
    const controller = new AbortController();
    const stopping = { ...options, signal: controller.signal, read: async (path: string) => { if (path === 'one.md') controller.abort(); return sources[path]!; } };
    await expect(regradeRecordedOutputs({ ...stopping, evaluation: { judges: { strong: testJudge([]) } } })).rejects.toThrow();
  });
  it('validates the manifest', () => {
    const raw = JSON.parse(JSON.stringify(manifest)) as { outputs: { id: string; output: string | null }[] };
    raw.outputs[1]!.id = 'base-clean';
    expect(regradeManifestSchema.safeParse(raw).success).toBe(false);
    raw.outputs[1]!.id = 'other'; raw.outputs[0]!.output = '../escape.json';
    expect(regradeManifestSchema.safeParse(raw).success).toBe(false);
    const empty = { ...JSON.parse(JSON.stringify(manifest)), outputs: [] };
    expect(regradeManifestSchema.safeParse(empty).success).toBe(false);
    expect(regradeManifestSchema.safeParse({ ...empty, critic: { judge: 'other', guide: ['g.md'], baseline: {}, candidates: {} } }).success).toBe(false);
  });
});
