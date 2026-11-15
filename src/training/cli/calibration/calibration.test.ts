import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDatasetYaml, resolveDataset } from '../../cases/index.js';
import { createEvaluationRegistry } from '../../evaluation/index.js';
import { testBankYaml, testJudge, testMaterial, testReplies } from '../../questionnaire/index.js';
import type { CliArguments } from '../arguments.js';
import { calibrationCalls, loadCalibrationSets, runTrainingCalibration } from './calibration.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const failing = { ...testReplies[0]!, figures: { answer: 'no', reason: 'headline "Seven"' } };
const context = { evidence: 'cases/evidence.json', assignment: 'cases/assignment.txt' };
const declared = { schema: 'spawnfile.training.calibration.v1', check: 'house',
  outputs: [{ id: 'clean', output: 'outputs/clean.json', context }, { id: 'figure', output: 'outputs/figure.json', context }],
  expect: [{ id: 'figure', base: 'clean', defect: 'figure', targets: ['figures'], gate_must_fail: true }] };

async function fixture(set: unknown = declared, bank = testBankYaml, frozen = testBankYaml, bound = true) {
  const root = await mkdtemp(join(tmpdir(), 'training-calibration-')); roots.push(root);
  await mkdir(join(root, 'calibration', 'outputs'), { recursive: true }); await mkdir(join(root, 'calibration', 'cases'));
  await writeFile(join(root, 'bank.yaml'), bank);
  await writeFile(join(root, 'calibration', 'set.json'), typeof set === 'string' ? set : JSON.stringify(set));
  await writeFile(join(root, 'calibration', 'outputs', 'clean.json'), JSON.stringify(testMaterial.output));
  await writeFile(join(root, 'calibration', 'outputs', 'figure.json'), JSON.stringify({ ...testMaterial.output, headline: 'Seven stations closed' }));
  await writeFile(join(root, 'calibration', 'cases', 'evidence.json'), JSON.stringify(testMaterial.context.evidence));
  await writeFile(join(root, 'calibration', 'cases', 'assignment.txt'), testMaterial.context.assignment);
  const check = { id: 'house', eval: 'questionnaire', bank: 'bank.yaml', input: 'artifact:output', feedback: 'status', ...(bound ? { context: { evidence: 'context:evidence', assignment: 'context:assignment' } } : {}) };
  const train = resolveDataset(parseDatasetYaml(JSON.stringify({ schema: 'spawnfile.training.dataset.v1', id: 'train',
    records: [{ id: 'story', group: 'a', input: { prompt: 'File.' }, outputs: { output: 'a.json' }, context: { evidence: [], assignment: 'a' }, checks: [check, { id: 'length', eval: 'word-count', input: 'output.text', min: 1 }] }] }), { sourceName: join(root, 'train.json') }),
    { registry: { judges: { strong: { version: '1' } } }, readCriterionFile: () => frozen });
  const args = { command: 'train', flags: {}, frozenDataset: { path: join(root, 'train.json'), sourceDigest: 'x' }, training: { models: {}, calibration: ['calibration/set.json'] } } as unknown as CliArguments;
  return { root, train, args, out: join(root, 'out') };
}
const run = (sets: ReturnType<typeof loadCalibrationSets>, out: string, strong: ReturnType<typeof testJudge>, events: unknown[] = []) =>
  runTrainingCalibration({ sets, out, registry: createEvaluationRegistry(), evaluation: { judges: { strong } }, observe: event => { events.push(event); } });

describe('calibration before training', () => {
  it('reads a declared set against the frozen check and counts its judge calls', async () => {
    const { train, args } = await fixture();
    const sets = loadCalibrationSets(args, train);
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ file: 'calibration/set.json', check: { id: 'house', eval: 'questionnaire', bank: 'bank.yaml', input: 'artifact:output' }, judgeCalls: { strong: 4 } });
    expect(sets[0]!.check).not.toHaveProperty('feedback');
    expect(calibrationCalls(sets)).toEqual({ strong: 4 });
    expect(loadCalibrationSets({ ...args, training: { models: {} } } as CliArguments, train)).toEqual([]);
  });

  it('judges every output once, keeps the results and asks nothing again on a resumed run', async () => {
    const { train, args, out } = await fixture();
    const sets = loadCalibrationSets(args, train), events: { payload: { status: string; judgeCalls: unknown[] } }[] = [];
    const strong = testJudge([testReplies[0], testReplies[1], failing, testReplies[1]]);
    const [first] = await run(sets, out, strong, events);
    expect(first).toMatchObject({ set: 'calibration/set.json', check: 'house', bank: { id: 'test-bank' }, outputs: 2, judgeCallsAsked: 4, report: { ok: true, caught: 1, gateFailed: 1, cleanBasesFailing: [] } });
    const directory = join(out, 'calibration', `set-${sets[0]!.digest.slice(0, 12)}`);
    expect(JSON.parse(await readFile(join(directory, 'CALIBRATION.json'), 'utf8'))).toMatchObject({ report: { ok: true } });
    expect(JSON.parse(await readFile(join(directory, 'results', 'figure.json'), 'utf8'))).toMatchObject({ id: 'figure', status: 'fail' });
    const idle = testJudge([]);
    const [resumed] = await run(sets, out, idle, events);
    expect(idle.prompts).toHaveLength(0);
    expect(resumed).toMatchObject({ judgeCallsAsked: 0, report: { ok: true } });
    // A restored judgment is still accounted: both passes report the same four calls.
    expect(events.map(event => [event.payload.status, event.payload.judgeCalls.length])).toEqual([['pass', 4], ['pass', 4]]);
  });

  it('refuses the run when the bank misses its set, and asks again only where the judge did not answer', async () => {
    const { train, args, out } = await fixture();
    const sets = loadCalibrationSets(args, train), events: { payload: { status: string } }[] = [];
    await expect(run(sets, out, testJudge([testReplies[0], testReplies[1], testReplies[0], testReplies[1]]), events))
      .rejects.toThrow(/Calibration refused the run: set calibration\/set\.json on check house caught 0 of 1 defects \(missed figure\), failed 0 of 1 required gates, 0 of 1 clean outputs fail a gate\. No trial was started/u);
    expect(events[0]!.payload.status).toBe('fail');
    const alarmed = await fixture();
    await expect(run(loadCalibrationSets(alarmed.args, alarmed.train), alarmed.out, testJudge([failing, testReplies[1], failing, testReplies[1]])))
      .rejects.toThrow(/1 of 1 clean outputs fail a gate \(clean\), clean outputs raise targeted questions \(clean figures\)\. No trial/u);
    const other = await fixture();
    const down = testJudge([new Error('down'), testReplies[1], failing, testReplies[1]]);
    await expect(run(loadCalibrationSets(other.args, other.train), other.out, down)).rejects.toThrow(/The judge did not answer for clean; a resumed run asks only for those/u);
    const again = testJudge([testReplies[0], testReplies[1]]);
    await expect(run(loadCalibrationSets(other.args, other.train), other.out, again)).resolves.toMatchObject([{ judgeCallsAsked: 2, report: { ok: true } }]);
    expect(again.prompts).toHaveLength(2);
  });

  it('refuses a set that is malformed, names another check, binds another context or meets a changed bank', async () => {
    const load = async (set: unknown, bank?: string) => { const { args, train } = await fixture(set, bank); return () => loadCalibrationSets(args, train); };
    expect(await load('{')).toThrow('is not JSON');
    expect(await load({ ...declared, schema: 'other' })).toThrow(/Calibration set calibration\/set\.json: schema/u);
    expect(await load({ ...declared, check: 'length' })).toThrow('is not a questionnaire check of the train dataset');
    expect(await load({ ...declared, outputs: [{ id: 'clean', output: 'outputs/clean.json' }, declared.outputs[1]] })).toThrow("must bind exactly the check's context (assignment, evidence)");
    expect(await load(declared, `${testBankYaml}\n# edited\n`)).toThrow('differs from the frozen train dataset');
  });

  it('judges a set of clean outputs alone on a bank that reads no context, nested in a logical check', async () => {
    const plain = testBankYaml.replace(/^ {2}- \{ from: context\.evidence.*\n {2}- context\.assignment\n/mu, '');
    const { root, args, out } = await fixture({ schema: declared.schema, check: 'house', outputs: [{ id: 'clean', output: 'outputs/clean.json' }], clean: ['clean'] }, plain, plain, false);
    const check = { id: 'house', eval: 'questionnaire', bank: 'bank.yaml', input: 'artifact:output' };
    const nested = resolveDataset(parseDatasetYaml(JSON.stringify({ schema: 'spawnfile.training.dataset.v1', id: 'train',
      records: [{ id: 'story', group: 'a', input: { prompt: 'File.' }, outputs: { output: 'a.json' }, checks: [{ id: 'all', all: [check, { not: { any: [{ eval: 'equals', input: 'output.text', value: 'x' }] } }] }] }] }), { sourceName: join(root, 'train.json') }),
      { registry: { judges: { strong: { version: '1' } } }, readCriterionFile: () => plain });
    const sets = loadCalibrationSets(args, nested);
    expect(sets[0]!.check).toEqual(check);
    await expect(runTrainingCalibration({ sets, out, registry: createEvaluationRegistry(), evaluation: { judges: { strong: testJudge([testReplies[0], testReplies[1]]) } } }))
      .resolves.toMatchObject([{ judgeCallsAsked: 2, report: { ok: true, defects: 0, cleanBases: 1 } }]);
    await expect(runTrainingCalibration({ sets, out: join(out, 'other'), registry: createEvaluationRegistry(), evaluation: { judges: { strong: testJudge([failing, testReplies[1]]) } } }))
      .rejects.toThrow(/caught 0 of 0 defects, failed 0 of 0 required gates, 1 of 1 clean outputs fail a gate \(clean\)\. No trial/u);
    delete (nested as { questionnaireCalls?: unknown }).questionnaireCalls;
    expect(loadCalibrationSets(args, nested)[0]!.judgeCalls).toEqual({});
  });

  it('refuses a check that uses two banks across train records and an input outside the set', async () => {
    const { root, args, train, out } = await fixture();
    const second = structuredClone(train.records[0]!);
    (second.effectiveStages[0]!.checks[0] as { bank: string }).bank = 'other.yaml';
    expect(() => loadCalibrationSets(args, { ...train, records: [train.records[0]!, second] })).toThrow('more than one bank or context binding');
    const [loaded] = loadCalibrationSets(args, train);
    const escaping = { ...loaded!, set: { ...loaded!.set, outputs: [{ ...loaded!.set.outputs[0]!, context: { evidence: 'cases/evidence.json', assignment: 'cases/../../bank.yaml' } }, loaded!.set.outputs[1]!] } };
    await expect(run([escaping], out, testJudge([]))).rejects.toThrow('Calibration input leaves its set');
    expect(root).toBeTruthy();
  });
});
