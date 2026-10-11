import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type { DecisionBackend } from '../../contracts/grading.js';
import type { InferenceProvider } from '../../contracts/execution.js';
import { createCalibrationIdentity, loadGrader, loadLabels, parseGrader, sha256, type Grader,
  type CalibrationFile } from '../../graders/index.js';
import { DECISION_PROMPT_VERSION } from '../../inference/decision/index.js';
import { backendIdentity } from './backend.js';
import { buildGradingRuntime } from './runtime.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const provider: InferenceProvider = { id: 'claude-subscription',
  capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
  generate: async () => { throw new Error('Builder must not generate'); } };

async function fixture(model: Grader['model'] = { backend: 'jev-http', endpoint: 'http://localhost:8123', name: 'decision' }) {
  const root = await mkdtemp(join(tmpdir(), 'grader-runtime-')); roots.push(root);
  const graderFile = join(root, 'grader.yaml');
  const source = parseGrader({ schema: 'paideia.grader.v1', id: 'report',
    golden: { schema: 'paideia.labels.v1', labelers: {}, labels: [] }, calibration: 'calibration.json',
    teachers: [{ id: 'teacher', provider: 'claude', model: 'opus' }], model,
    escalate: { to: 'teacher', between: [0.4, 0.6] },
    questions: [{ id: 'q', type: 'yes-no', expected: 'yes', reads: ['output.body'] }],
    score: { method: 'weighted', pass_at: 0.8 } });
  await writeFile(graderFile, stringify(source));
  const backend: DecisionBackend = { identity: async () => ({ backend: model.backend, model: 'reported' }),
    score: async () => { throw new Error('Builder must not score'); } };
  const grader = await loadGrader(graderFile);
  const golden = await loadLabels(grader.golden, grader);
  const calibration: CalibrationFile = { schema: 'paideia.grader-calibration.v1',
    identity: createCalibrationIdentity(grader, { backendModel: await backendIdentity(grader, backend),
      golden: golden.goldenDigest, promptTemplateVersion: DECISION_PROMPT_VERSION, seed: 'seed', exclusions: [] }),
    questions: { q: { status: 'calibrated', failures: [], params: { a: 1, b: 0 }, band: [0.4, 0.6],
      metrics: { groups: 20, instances: 40, good: 20, bad: 20, baseRate: 0.5 } } } };
  await writeFile(grader.calibration, JSON.stringify(calibration));
  const factory = vi.fn(() => provider);
  return { root, source, grader, graderFile, backend, calibration, factory,
    dependencies: { backend: () => backend, provider: factory } };
}

it('binds exact file digests and shares normalized endpoint resources across distinct graders', async () => {
  const first = await fixture();
  const second = await fixture({ backend: 'ollama-logprobs', endpoint: 'http://localhost:8123/', name: 'other' });
  const third = await fixture({ backend: 'jev-http', endpoint: 'http://localhost:8124', name: 'other' });
  const a = await buildGradingRuntime(first.graderFile, first.dependencies);
  const b = await buildGradingRuntime(second.graderFile, second.dependencies);
  const c = await buildGradingRuntime(third.graderFile, third.dependencies);
  expect(a.resource).toBe(b.resource);
  expect(a.resource).not.toBe(c.resource);
  expect(a.backend).toBe(first.backend);
  expect(a.teacher).toEqual({ provider, model: 'opus' });
  expect(first.factory).toHaveBeenCalledWith(first.grader.teachers[0]);
  expect(a.definitionDigest).toBe(sha256(await readFile(first.graderFile)));
  expect(a.calibrationDigest).toBe(sha256(await readFile(first.grader.calibration)));
  expect(a.goldenDigest).toBe(first.calibration.identity.golden);
  expect(a.promptTemplateVersion).toBe(DECISION_PROMPT_VERSION);
  const defaultTeacher = await buildGradingRuntime(first.graderFile, { backend: () => first.backend });
  expect(defaultTeacher.teacher!.provider.id).toBe('claude-subscription');
});

it('shares teacher backend resources without sharing local endpoint resources', async () => {
  const first = await fixture({ backend: 'teacher', teacher: 'teacher' });
  const second = await fixture({ backend: 'teacher', teacher: 'teacher' });
  const local = await fixture();
  const a = await buildGradingRuntime(first.graderFile, first.dependencies);
  expect(a.resource).toBe((await buildGradingRuntime(second.graderFile, second.dependencies)).resource);
  expect(a.resource).not.toBe((await buildGradingRuntime(local.graderFile, local.dependencies)).resource);
});

it('refuses changed backend, golden, rubric, prompt and exclusion identities before constructing a teacher', async () => {
  const f = await fixture();
  const original = structuredClone(f.calibration);
  for (const component of ['backendModel', 'golden', 'promptTemplateVersion', 'segmenter'] as const) {
    f.calibration.identity[component] = component === 'golden' ? '0'.repeat(64) : 'changed';
    await writeFile(f.grader.calibration, JSON.stringify(f.calibration));
    await expect(buildGradingRuntime(f.graderFile, f.dependencies)).rejects.toThrow(`identity mismatch: ${component}`);
    f.calibration = structuredClone(original);
  }
  f.calibration.identity.questions.q = '0'.repeat(64);
  await writeFile(f.grader.calibration, JSON.stringify(f.calibration));
  await expect(buildGradingRuntime(f.graderFile, f.dependencies)).rejects.toThrow('identity mismatch: questions');
  const excluded = join(f.root, 'test.yaml');
  await writeFile(excluded, stringify({ schema: 'paideia.dataset.v1', records: [{ id: 'sealed' }] }));
  f.calibration = structuredClone(original);
  f.calibration.identity.exclusions = [{ dataset: excluded, digest: sha256(await readFile(excluded)) }];
  await writeFile(f.grader.calibration, JSON.stringify(f.calibration));
  await writeFile(excluded, stringify({ schema: 'paideia.dataset.v1', records: [{ id: 'changed' }] }));
  await expect(buildGradingRuntime(f.graderFile, f.dependencies)).rejects.toThrow('identity mismatch: exclusions');
  expect(f.factory).not.toHaveBeenCalled();
});

it('refuses changed golden content and stale stored votes rather than treating prior labels as current', async () => {
  const f = await fixture();
  f.source.golden = { schema: 'paideia.labels.v1', labelers: { human: { kind: 'human', name: 'Reader' } }, labels: [] };
  await writeFile(f.graderFile, stringify(f.source));
  await expect(buildGradingRuntime(f.graderFile, f.dependencies)).rejects.toThrow('identity mismatch: golden');
  f.source.golden = { schema: 'paideia.labels.v1', labelers: { teacher: { kind: 'model', provider: 'claude', model: 'opus' } },
    labels: [{ id: 'o', lineage: 'o', output: { body: ['Report.'] }, context: {}, votes: { q: { teacher: 'yes' } }, provenance: {} }] };
  await writeFile(f.graderFile, stringify(f.source));
  await expect(buildGradingRuntime(f.graderFile, f.dependencies)).rejects.toThrow('Stale vote');
  expect(f.factory).not.toHaveBeenCalled();
});

it('enforces calibration quality policy and detects definition edits during provider initialization', async () => {
  const f = await fixture();
  f.calibration.questions.q!.status = 'insufficient-evidence';
  f.calibration.questions.q!.failures = ['held-out groups'];
  await writeFile(f.grader.calibration, JSON.stringify(f.calibration));
  await expect(buildGradingRuntime(f.graderFile, f.dependencies)).rejects.toThrow('question q: held-out groups');
  f.source.uncalibrated = 'teacher';
  await writeFile(f.graderFile, stringify(f.source));
  await expect(buildGradingRuntime(f.graderFile, f.dependencies)).rejects.toThrow('identity mismatch: uncalibrated');
  f.calibration.identity = createCalibrationIdentity({ ...f.grader, uncalibrated: 'teacher' }, f.calibration.identity);
  await writeFile(f.grader.calibration, JSON.stringify(f.calibration));
  expect((await buildGradingRuntime(f.graderFile, f.dependencies)).grader.uncalibrated).toBe('teacher');
  f.backend.identity = async () => {
    await writeFile(f.graderFile, `${stringify(f.source)}\n# edited while loading\n`);
    return { backend: 'jev-http', model: 'reported' };
  };
  await expect(buildGradingRuntime(f.graderFile, f.dependencies)).rejects.toThrow('Grader file changed while loading');
});

it('refuses missing calibration, malformed calibration and unavailable exclusions', async () => {
  const f = await fixture();
  f.calibration.identity.exclusions = [{ dataset: join(f.root, 'missing.yaml'), digest: '0'.repeat(64) }];
  await writeFile(f.grader.calibration, JSON.stringify(f.calibration));
  await expect(buildGradingRuntime(f.graderFile, f.dependencies)).rejects.toThrow('ENOENT');
  await writeFile(f.grader.calibration, '{}');
  await expect(buildGradingRuntime(f.graderFile, f.dependencies)).rejects.toThrow('schema');
  await rm(f.grader.calibration);
  await expect(buildGradingRuntime(f.graderFile, f.dependencies)).rejects.toThrow('ENOENT');
});
