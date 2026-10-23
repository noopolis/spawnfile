import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { labelsSchema, parseLabels } from './labels.js';
import { identifier, probability, provider, parseSchema, parseYaml, rememberSourceDirectory } from './common.js';
import { questionSchema, gateQuestionSchema, validateQuestion, allQuestions } from './questions.js';
import { rowsSchema } from './rows.js';
import { requiresArgumentBinding } from './binding.js';

const between = z.tuple([probability, probability]).refine(([lo, hi]) => lo < hi, 'requires lo < hi');
const escalation = z.union([
  z.strictObject({ to: identifier, between, max_calls_per_trial: z.number().int().positive().optional() }),
  z.strictObject({ to: identifier, target_accuracy: z.number().gt(0.5).max(1), max_calls_per_trial: z.number().int().positive().optional() }),
]);
const localModel = z.strictObject({ backend: z.literal('jev-http'), endpoint: z.url(), name: z.string().min(1) });
const ollamaModel = localModel.extend({ backend: z.literal('ollama-logprobs'),
  context_tokens: z.number().int().min(2048).max(131072).default(16384) });
const teacherModel = z.strictObject({ backend: z.literal('teacher'), teacher: identifier });
const typeSafeModel = z.strictObject({ backend: z.literal('typesafe'), name: z.string().regex(/^jev-\d+\.\d+\.\d+$/),
  endpoint: z.url({ protocol: /^https$/ }).default('https://api.typesafe.ai/v1/systemone'),
  price_per_mtok_usd: z.number().finite().positive().optional(), concurrency: z.number().int().min(1).max(32).default(8) });
const modelSchema = z.union([localModel, ollamaModel, teacherModel, typeSafeModel]);
const namedModelSchema = z.union([localModel.extend({ id: identifier }), ollamaModel.extend({ id: identifier }), teacherModel.extend({ id: identifier }), typeSafeModel.extend({ id: identifier })]);
export type DecisionModel = z.infer<typeof modelSchema>;
export type NamedDecisionModel = z.infer<typeof namedModelSchema>;
export const graderSchema = z.strictObject({
  schema: z.literal('paideia.grader.v1'), id: identifier,
  golden: z.union([z.string().min(1), labelsSchema.extend({ grader: identifier.optional() })]), calibration: z.string().min(1),
  context: z.record(identifier, z.strictObject({ description: z.string(), rows: rowsSchema.optional() })).default({}),
  teachers: z.array(z.strictObject({ id: identifier, provider, model: z.string().min(1), effort: z.string().min(1).optional() })),
  model: modelSchema.optional(),
  max_spend_usd: z.number().finite().nonnegative().optional(),
  models: z.array(namedModelSchema).min(1).max(4).optional(),
  escalate: escalation,
  uncalibrated: z.enum(['refuse', 'teacher']).default('refuse'),
  gates: z.array(z.union([z.strictObject({ id: identifier, check: z.record(z.string(), z.unknown()) }), gateQuestionSchema])).default([]),
  questions: z.array(questionSchema).min(1),
  score: z.strictObject({ method: z.enum(['weighted', 'fitted-weights']), pass_at: probability.default(0) }),
}).refine(value => (value.model === undefined) !== (value.models === undefined), {
  path: ['models'], message: 'exactly one of model or models is required',
});
export type Grader = z.infer<typeof graderSchema>;
export type Gate = Grader['gates'][number];

/** Check parameters remain opaque; inspect only logical children for gate binding. */
export function checkBinding(check: Record<string, unknown>, location: string): void {
  if (check.eval === 'tool-called' || check.eval === 'tool-count') throw new Error(`${location}.eval: unbound tool gate`);
  if (check.eval === 'tool-sequence' && (check.ending_at as { event?: unknown } | undefined)?.event !== 'accepted-call') {
    throw new Error(`${location}.ending_at.event: requires accepted-call`);
  }
  if (check.eval === 'tool-sequence') {
    const steps = Array.isArray(check.steps) ? check.steps as { bind?: Record<string, unknown>; where?: { cel?: unknown } }[] : [];
    const cel = steps.at(-1)?.where?.cel;
    const bound = new Set(steps.slice(0, -1).flatMap(step => Object.keys(step?.bind ?? {})));
    if (!requiresArgumentBinding(cel, bound)) {
      throw new Error(`${location}.steps: final where.cel must require argument equality to an earlier step binding`);
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

export { allQuestions } from './questions.js';

function validateStructure(grader: Grader): void {
  const teachers = new Set<string>();
  grader.teachers.forEach((teacher, i) => {
    if (teachers.has(teacher.id)) throw new Error(`$.teachers.${i}.id: duplicate teacher`);
    teachers.add(teacher.id);
  });
  if (grader.calibration !== 'identity' && !teachers.size) throw new Error('$.teachers: requires at least one teacher');
  if (grader.calibration !== 'identity' && !teachers.has(grader.escalate.to)) throw new Error('$.escalate.to: unknown teacher');
  const models = decisionModels(grader);
  if (grader.calibration === 'identity' && (grader.models !== undefined || models.length !== 1 || models[0]!.backend === 'teacher' ||
    grader.teachers.length || grader.escalate.to !== 'none' || grader.uncalibrated !== 'refuse')) {
    throw new Error('$.calibration: identity requires one decision model, no teachers or escalation, and uncalibrated: refuse');
  }
  if (grader.calibration === 'identity' && models[0]!.backend === 'typesafe' && grader.max_spend_usd === undefined) {
    throw new Error('$.max_spend_usd: identity TypeSafe grading requires an explicit spend cap');
  }
  if (grader.calibration === 'identity' && (typeof grader.golden === 'string' || grader.golden.labels.length ||
    Object.keys(grader.golden.labelers).length || !('between' in grader.escalate) ||
    grader.escalate.between[0] !== 0 || grader.escalate.between[1] !== 1 || grader.escalate.max_calls_per_trial !== undefined)) {
    throw new Error('$.calibration: identity cannot declare golden labels or escalation');
  }
  const modelIds = new Set<string>();
  for (const model of models) {
    if (modelIds.has(model.id)) throw new Error(`$.models.${model.id}: duplicate model id`);
    modelIds.add(model.id);
    if (model.backend === 'teacher' && !teachers.has(model.teacher)) throw new Error(`$.model.teacher (${model.id}): unknown teacher`);
  }
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
  // Only explicit identity mode supplies the unused legacy authoring fields.
  if (value && typeof value === 'object' && 'calibration' in value && value.calibration === 'identity') {
    value = { golden: { schema: 'paideia.labels.v1', labelers: {}, labels: [] },
      teachers: [], escalate: { to: 'none', between: [0, 1] }, ...value };
  }
  const grader = parseSchema(graderSchema, value);
  validateStructure(grader);
  if (typeof grader.golden !== 'string') parseLabels({ ...grader.golden, grader: grader.golden.grader ?? grader.id }, grader);
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
  const directory = path.dirname(path.resolve(filename));
  const loaded = { ...grader, golden: typeof grader.golden === 'string' ? path.resolve(directory, grader.golden) : grader.golden,
    calibration: grader.calibration === 'identity' ? 'identity' : path.resolve(directory, grader.calibration) };
  rememberSourceDirectory(loaded, directory);
  return loaded;
}

/** Legacy model syntax has exactly the same routing semantics as id default. */
export function decisionModels(grader: Grader): NamedDecisionModel[] {
  return grader.models ?? [{ ...grader.model!, id: 'default' }];
}

/** A single-model view for transports and independent teacher truth. */
export function graderForModel(grader: Grader, model: NamedDecisionModel): Grader & { model: DecisionModel } {
  const { models: _models, ...rest } = grader;
  const { id: _id, ...definition } = model;
  return { ...rest, model: definition };
}
