import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { identifier, probability, provider, parseSchema, parseYaml } from './common.js';
import { questionSchema, gateQuestionSchema, validateQuestion, applicabilityQuestion, type DecisionQuestion } from './questions.js';

const between = z.tuple([probability, probability]).refine(([lo, hi]) => lo < hi, 'requires lo < hi');
const escalation = z.union([
  z.strictObject({ to: identifier, between, max_calls_per_trial: z.number().int().positive().optional() }),
  z.strictObject({ to: identifier, target_accuracy: z.number().gt(0.5).max(1), max_calls_per_trial: z.number().int().positive().optional() }),
]);
export const graderSchema = z.strictObject({
  schema: z.literal('paideia.grader.v1'), id: identifier,
  golden: z.string().min(1), calibration: z.string().min(1),
  context: z.record(identifier, z.strictObject({ description: z.string() })).default({}),
  teachers: z.array(z.strictObject({ id: identifier, provider, model: z.string().min(1), effort: z.string().min(1).optional() })).min(1),
  model: z.union([
    z.strictObject({ backend: z.enum(['jev-http', 'ollama-logprobs']), endpoint: z.url(), name: z.string().min(1) }),
    z.strictObject({ backend: z.literal('teacher'), teacher: identifier }),
  ]),
  escalate: escalation,
  uncalibrated: z.enum(['refuse', 'teacher']).default('refuse'),
  gates: z.array(z.union([z.strictObject({ id: identifier, check: z.record(z.string(), z.unknown()) }), gateQuestionSchema])).default([]),
  questions: z.array(questionSchema).min(1),
  score: z.strictObject({ method: z.enum(['weighted', 'fitted-weights']), pass_at: probability.default(0) }),
});
export type Grader = z.infer<typeof graderSchema>;
export type Gate = Grader['gates'][number];

/** Check parameters remain opaque; inspect only logical children for gate binding. */
function checkBinding(check: Record<string, unknown>, location: string): void {
  if (check.eval === 'tool-called' || check.eval === 'tool-count') throw new Error(`${location}.eval: unbound tool gate`);
  if (check.eval === 'tool-sequence' && (check.ending_at as { event?: unknown } | undefined)?.event !== 'accepted-call') {
    throw new Error(`${location}.ending_at.event: requires accepted-call`);
  }
  if (check.eval === 'tool-sequence') {
    const steps = Array.isArray(check.steps) ? check.steps as { bind?: Record<string, unknown>; where?: { cel?: unknown } }[] : [];
    const cel = steps.at(-1)?.where?.cel;
    const bound = new Set(steps.slice(0, -1).flatMap(step => Object.keys(step?.bind ?? {})));
    const references = typeof cel === 'string' ? [...cel.matchAll(/\bbindings\.([A-Za-z_][A-Za-z0-9_]*)/g)] : [];
    if (!references.some(match => bound.has(match[1]!))) {
      throw new Error(`${location}.steps: final where.cel must reference bindings from an earlier step bind`);
    }
  }
  for (const op of ['all', 'any', 'not']) {
    const children = check[op];
    const items = Array.isArray(children) ? children : [children];
    items.forEach((child, i) => {
      if (child && typeof child === 'object') checkBinding(child as Record<string, unknown>, `${location}.${op}.${i}`);
    });
  }
}

export function allQuestions(grader: Grader): DecisionQuestion[] {
  const questions: DecisionQuestion[] = [...grader.questions, ...grader.gates.filter((gate): gate is Exclude<Gate, { check: unknown }> => !('check' in gate))];
  return questions.flatMap(question => typeof question.when === 'string' ? [question, applicabilityQuestion(question)] : [question]);
}

function validateStructure(grader: Grader): void {
  const teachers = new Set<string>();
  grader.teachers.forEach((teacher, i) => {
    if (teachers.has(teacher.id)) throw new Error(`$.teachers.${i}.id: duplicate teacher`);
    teachers.add(teacher.id);
  });
  if (!teachers.has(grader.escalate.to)) throw new Error('$.escalate.to: unknown teacher');
  if (grader.model.backend === 'teacher' && !teachers.has(grader.model.teacher)) throw new Error('$.model.teacher: unknown teacher');
  const ids = new Set<string>();
  for (const [collection, entries] of [['questions', grader.questions], ['gates', grader.gates]] as const) {
    entries.forEach((entry, i) => {
      const location = `$.${collection}.${i}`;
      if (ids.has(entry.id) || entry.id.includes('@')) throw new Error(`${location}.id: duplicate or reserved instance ID`);
      ids.add(entry.id);
      if ('check' in entry) checkBinding(entry.check, `${location}.check`);
      else {
        validateQuestion(entry, grader.context, location);
        if (collection === 'gates' && entry.level !== 'article') throw new Error(`${location}.level: gates require article`);
      }
    });
  }
  for (const question of allQuestions(grader)) {
    if (typeof question.when === 'string' && ids.has(`${question.id}.applies`)) throw new Error(`$.questions.${question.id}.id: derived ID collision`);
  }
  const total = grader.questions.reduce((sum, question) => sum + question.weight, 0);
  if (!Number.isFinite(total) || total <= 0) throw new Error('$.questions.weight: requires finite positive total');
}

/** Parsing preserves recognized future methods; executable validation refuses them. */
export function parseGrader(value: unknown): Grader {
  const grader = parseSchema(graderSchema, value);
  validateStructure(grader);
  return grader;
}
export function parseGraderYaml(source: string): Grader { return parseGrader(parseYaml(source)); }
export function validateGrader(value: unknown): Grader {
  const grader = parseGrader(value);
  if (grader.score.method === 'fitted-weights') throw new Error('$.score.method: fitted-weights not implemented in v1');
  return grader;
}
export async function loadGrader(filename: string): Promise<Grader> {
  const grader = validateGrader(parseGraderYaml(await readFile(filename, 'utf8')));
  return { ...grader, golden: path.resolve(path.dirname(filename), grader.golden), calibration: path.resolve(path.dirname(filename), grader.calibration) };
}
