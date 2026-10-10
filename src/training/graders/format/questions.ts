import { z } from 'zod';
import { identifier, probability } from './common.js';

const predicate = z.union([
  z.strictObject({ field: z.string().min(1), equals: z.json() }),
  z.strictObject({ field: z.string().min(1), in: z.array(z.json()).min(1) }),
]);
const fields = {
  id: identifier,
  level: z.enum(['article', 'paragraph', 'sentence']).default('article'),
  ask: z.string().min(1).optional(),
  type: z.enum(['yes-no', 'choice', 'score']),
  expected: z.union([z.string(), z.number(), z.array(z.string()), z.array(z.number())]),
  options: z.array(identifier).min(2).max(16).optional(),
  scale: z.tuple([z.number().int(), z.number().int()]).optional(),
  reads: z.array(z.string().min(1)),
  when: z.union([z.string().min(1), predicate]).optional(),
  not_applicable: probability.default(1),
};
export const questionSchema = z.strictObject({ ...fields, weight: z.number().nonnegative().default(1) });
export const gateQuestionSchema = z.strictObject(fields);
export type Question = z.infer<typeof questionSchema>;
export type GateQuestion = z.infer<typeof gateQuestionSchema>;
export type DecisionQuestion = Question | GateQuestion;
export type Option = string | number;

export function optionsFor(question: DecisionQuestion): Option[] {
  if (question.type === 'yes-no') return ['yes', 'no'];
  if (question.type === 'choice') return question.options!;
  const [lo, hi] = question.scale!;
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

export function expectedOptions(question: DecisionQuestion): Option[] {
  const expected = question.expected;
  if (question.type !== 'score' || typeof expected !== 'string') {
    return Array.isArray(expected) ? expected : [expected];
  }
  const match = /^(>=|<=)\s*(-?\d+)$/.exec(expected);
  if (!match) return [];
  const n = Number(match[2]);
  return optionsFor(question).filter(value => match[1] === '>=' ? Number(value) >= n : Number(value) <= n);
}

export function validRead(read: string, question: DecisionQuestion, context: Record<string, unknown>): boolean {
  if (/^output\.[^.]+(?:\.[^.]+)*$/.test(read)) return true;
  if (read.startsWith('context.')) return Object.hasOwn(context, read.slice(8));
  if (read === 'sentence') return question.level === 'sentence';
  return ['paragraph', 'previous-paragraph', 'next-paragraph'].includes(read) && question.level !== 'article';
}

export function validateQuestion(question: DecisionQuestion, context: Record<string, unknown>, path: string): void {
  const fail = (field: string, message: string): never => { throw new Error(`${path}.${field}: ${message}`); };
  if (question.type === 'choice' && (!question.options || new Set(question.options).size !== question.options.length || question.options.includes('abstain'))) {
    fail('options', 'requires 2–16 unique options; abstain is reserved');
  }
  if (question.type === 'score' && (!question.scale || question.scale[1] - question.scale[0] < 1 ||
    question.scale[1] - question.scale[0] > 15)) fail('scale', 'requires 2–16 integer points');
  if (question.type !== 'choice' && question.options) fail('options', 'only valid for choice');
  if (question.type !== 'score' && question.scale) fail('scale', 'only valid for score');
  if (question.type === 'yes-no' && (typeof question.expected !== 'string' || !['yes', 'no'].includes(question.expected))) fail('expected', 'requires yes or no');
  if (question.type === 'choice' && !Array.isArray(question.expected)) fail('expected', 'requires an option subset');
  const expected = expectedOptions(question);
  const options = optionsFor(question);
  if (!expected.length || expected.length >= options.length || new Set(expected).size !== expected.length ||
    expected.some(value => !options.includes(value))) fail('expected', 'requires a nonempty proper subset of options');
  question.reads.forEach((read, index) => {
    if (!validRead(read, question, context)) fail(`reads.${index}`, 'unknown or unavailable read');
  });
  if (question.when && typeof question.when !== 'string' && !validRead(question.when.field, question, context)) {
    fail('when.field', 'unknown or unavailable field');
  }
}

export function applicabilityQuestion(question: DecisionQuestion): GateQuestion {
  return {
    id: `${question.id}.applies`, level: question.level, ask: question.when as string,
    type: 'yes-no', expected: 'yes', reads: [...question.reads], not_applicable: 1,
  };
}
