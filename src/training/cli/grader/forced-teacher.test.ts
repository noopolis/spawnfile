import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type { DecisionBackend } from '../../contracts/grading.js';
import { parseGrader, splitCalibration, stableDigest } from '../../graders/index.js';
import { teacherPolicyDigest } from '../../graders/labeling/index.js';
import { runCalibrate } from './calibrate.js';
import { runGrade } from './grade.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.each(['jev-http', 'teacher'] as const)('persists independent teacher accuracy and refuses weak forced routing (%s)', async backend => {
  const root = await mkdtemp(join(tmpdir(), 'forced-teacher-')); roots.push(root);
  const graderFile = join(root, 'grader.yaml');
  const grader = parseGrader({ schema: 'paideia.grader.v1', id: 'g', golden: 'labels.yaml', calibration: 'calibration.json',
    teachers: [{ id: 't', provider: 'claude', model: 'opus' }],
    model: backend === 'teacher' ? { backend, teacher: 't' } : { backend, endpoint: 'http://localhost:8000', name: 'model' },
    uncalibrated: 'teacher', escalate: { to: 't', between: [0.4, 0.6] },
    questions: [{ id: 'q', type: 'yes-no', expected: 'yes', reads: ['output.data'] }], score: { method: 'weighted' } });
  const population = Array.from({ length: 200 }, (_, i) => ({ questionId: 'q', type: 'yes-no' as const,
    group: `g${i}`, good: i % 2 === 0, rawPGood: 0.5, source: 'human' as const }));
  const held = splitCalibration(population, '0').heldOut;
  const wrong = new Set(held.slice(72).map(row => row.group));
  const labels = population.map((row, i) => {
    const output = { id: i, good: row.good };
    const good = wrong.has(row.group) ? !row.good : row.good;
    const provenance = { question_digest: stableDigest(grader.questions[0]), projection_digest: stableDigest({ 'output.data': output }) };
    return { id: `o${i}`, lineage: row.group, output: { data: output }, context: {}, votes: { q: { human: row.good ? 'yes' : 'no', t: good ? 'yes' : 'no' } },
      provenance: { human: { votes: { q: provenance } }, t: { votes: { q: {
        ...provenance, teacher_policy_digest: teacherPolicyDigest(grader.teachers[0]!),
      } } } } };
  });
  await writeFile(graderFile, stringify(grader));
  await writeFile(join(root, 'labels.yaml'), stringify({ schema: 'paideia.labels.v1', grader: 'g', labels,
    labelers: { human: { kind: 'human', name: 'H' }, t: { kind: 'model', provider: 'claude', model: 'opus' } } }));
  const score = vi.fn<DecisionBackend['score']>(async requests => requests.map(request => {
    const output = request.projection['output.data'] as { id: number; good: boolean };
    const good = wrong.has(`g${output.id}`) ? !output.good : output.good;
    const yes = backend === 'teacher' ? Number(good) : 0.5;
    return { key: request.key, status: 'ok', probabilities: { yes, no: 1 - yes } };
  }));
  const dependencies = { backend: (): DecisionBackend => ({ identity: async () => ({ backend, model: 'fake' }), score }) };
  const result = await runCalibrate({ graderFile }, dependencies);
  expect(result.code).toBe(1);
  expect(result.calibration.questions.q!.teacherAccuracy).toMatchObject({ groups: 100, instances: 100, agreement: 0.72,
    failures: ['teacher.agreement >= 0.85'] });
  expect(JSON.parse(await readFile(result.calibrationFile, 'utf8')).questions.q.teacherAccuracy.agreement).toBe(0.72);
  expect(await readFile(result.reportFile, 'utf8')).toContain('Teacher independent held-out accuracy: 0.720');
  const outputFile = join(root, 'output.json');
  await writeFile(outputFile, JSON.stringify({ data: { id: 201, good: true } }));
  score.mockClear();
  await expect(runGrade({ graderFile, outputFile }, dependencies)).rejects.toThrow('teacher.agreement >= 0.85');
  expect(score).not.toHaveBeenCalled();
});

it.each(['editor', 'human', 'provider', 'model', 'policy'] as const)('refuses forged teacher %s evidence before calibration inference', async forgery => {
  const root = await mkdtemp(join(tmpdir(), 'teacher-identity-')); roots.push(root);
  const graderFile = join(root, 'grader.yaml');
  const grader = parseGrader({ schema: 'paideia.grader.v1', id: 'g', golden: 'labels.yaml', calibration: 'c.json',
    teachers: [{ id: 't', provider: 'claude', model: 'opus' }],
    model: { backend: 'jev-http', endpoint: 'http://localhost:8000', name: 'model' },
    uncalibrated: 'teacher', escalate: { to: 't', between: [0.4, 0.6] },
    questions: [{ id: 'q', type: 'yes-no', expected: 'yes', reads: ['output.data'] }], score: { method: 'weighted' } });
  const labeler = forgery === 'editor' || forgery === 'human' ? { kind: forgery, name: 'Impersonator' }
    : { kind: 'model', provider: forgery === 'provider' ? 'grok' : 'claude', model: forgery === 'model' ? 'wrong' : 'opus' };
  const labels = Array.from({ length: 100 }, (_, i) => {
    const answer = i % 2 ? 'yes' : 'no';
    const metadata = { question_digest: stableDigest(grader.questions[0]), projection_digest: stableDigest({ 'output.data': i }) };
    return { id: `o${i}`, lineage: `g${i}`, output: { data: i }, context: {}, votes: { q: { h: answer, t: answer } },
      provenance: { h: { votes: { q: metadata } }, t: { votes: { q: { ...metadata,
        ...(forgery === 'policy' ? {} : { teacher_policy_digest: teacherPolicyDigest(grader.teachers[0]!) }) } } } } };
  });
  await writeFile(graderFile, stringify(grader));
  await writeFile(join(root, 'labels.yaml'), stringify({ schema: 'paideia.labels.v1', grader: 'g', labels,
    labelers: { h: { kind: 'human', name: 'Independent' }, t: labeler } }));
  const backend = vi.fn((): DecisionBackend => ({ identity: async () => ({ backend: 'jev-http', model: 'model' }),
    score: async requests => requests.map(request => ({ key: request.key, status: 'ok', probabilities: { yes: 0.5, no: 0.5 } })) }));
  await expect(runCalibrate({ graderFile }, { backend })).rejects.toThrow(forgery === 'policy' ? 'Stale vote' : 'Teacher identity mismatch');
  expect(backend).not.toHaveBeenCalled();
  await expect(readFile(join(root, 'c.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
