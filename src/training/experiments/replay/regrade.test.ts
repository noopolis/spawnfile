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
  it('validates the manifest', () => {
    const raw = JSON.parse(JSON.stringify(manifest)) as { outputs: { id: string; output: string | null }[] };
    raw.outputs[1]!.id = 'base-clean';
    expect(regradeManifestSchema.safeParse(raw).success).toBe(false);
    raw.outputs[1]!.id = 'other'; raw.outputs[0]!.output = '../escape.json';
    expect(regradeManifestSchema.safeParse(raw).success).toBe(false);
  });
});
