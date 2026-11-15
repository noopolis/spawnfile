import { z } from 'zod';
import type { QuestionnaireResult } from './run.js';

/** One output with a single injected defect, the clean output it was made from, and what the bank must do with it. */
export const calibrationExpectationSchema = z.array(z.object({
  id: z.string().min(1), base: z.string().min(1), defect: z.string().min(1), injected: z.string().optional(),
  targets: z.array(z.string().min(1)).min(1), gate_must_fail: z.boolean(),
}).strict()).min(1);
export type CalibrationExpectation = z.infer<typeof calibrationExpectationSchema>[number];

export const CALIBRATION_SCHEMA = 'spawnfile.training.calibration.v1' as const;
const name = z.string().regex(/^[A-Za-z0-9._-]+$/u);
const relative = z.string().min(1).refine(value => !value.startsWith('/') && !value.includes('\\') && !value.split('/').includes('..'), 'expected a contained relative path');
/**
 * A declared calibration set: recorded outputs the bank must judge as expected before a run may trust it.
 * `expect` lists outputs with one injected defect against their clean base; `clean` lists further known
 * good outputs. Every base and every clean output must pass the bank's gate. Paths are relative to the set.
 */
export const calibrationSetSchema = z.strictObject({
  schema: z.literal(CALIBRATION_SCHEMA),
  /** The questionnaire check of the train dataset whose bank is calibrated. */
  check: name,
  outputs: z.array(z.strictObject({ id: name, output: relative, context: z.record(z.string().regex(/^[A-Za-z_][\w-]*$/u), relative).optional() })).min(1),
  expect: calibrationExpectationSchema.optional(),
  clean: z.array(name).optional(),
}).superRefine((set, context) => {
  const ids = new Set(set.outputs.map(output => output.id));
  if (ids.size !== set.outputs.length) context.addIssue({ code: 'custom', path: ['outputs'], message: 'output ids must be unique' });
  if (!set.expect && !set.clean?.length) context.addIssue({ code: 'custom', path: ['expect'], message: 'a calibration set expects something: expect or clean' });
  for (const id of [...(set.expect ?? []).flatMap(entry => [entry.id, entry.base]), ...set.clean ?? []]) {
    if (!ids.has(id)) context.addIssue({ code: 'custom', path: ['outputs'], message: `expectation names an undeclared output: ${id}` });
  }
});
export type CalibrationSet = z.infer<typeof calibrationSetSchema>;

export interface CalibrationReport {
  defects: number;
  /** A target question scored lower on the variant than on its clean base. */
  caught: number;
  gateRequired: number;
  gateFailed: number;
  cleanBases: number;
  cleanBasesFailing: string[];
  /** A question some defect targets, failed on a clean output: the bank raises the defect where there is none. */
  cleanFalseAlarms: { output: string; question: string; answer: unknown }[];
  missing: string[];
  rows: { id: string; defect: string; caught: boolean; gate: string; baseGate: string; targets: { id: string; base: unknown; variant: unknown }[] }[];
  /** Every defect caught, every required gate failed, no clean base failing or raising a targeted defect, nothing missing. */
  ok: boolean;
}

/** One declared calibration set as a run judged it before its first trial. */
export interface CalibrationRun {
  set: string;
  check: string;
  bank: { id: string; digest: string };
  outputs: number;
  /** Calls asked by this invocation; a resumed run asks none for outputs it already holds. */
  judgeCallsAsked: number;
  report: CalibrationReport;
}

/** Compares graded results against a bank's calibration set. Pure: it never asks a judge. */
export function checkQuestionnaireCalibration(expectations: readonly CalibrationExpectation[],
  results: Readonly<Record<string, QuestionnaireResult>>, clean: readonly string[] = []): CalibrationReport {
  const rows: CalibrationReport['rows'] = [];
  const missing: string[] = [];
  const answer = (result: QuestionnaireResult, id: string) => result.answers.find(entry => entry.id === id);
  for (const expectation of expectations) {
    const variant = Object.hasOwn(results, expectation.id) ? results[expectation.id] : undefined;
    const base = Object.hasOwn(results, expectation.base) ? results[expectation.base] : undefined;
    if (!variant || !base) { missing.push(!variant ? expectation.id : expectation.base); continue; }
    const targets = expectation.targets.map(id => ({ id, base: answer(base, id), variant: answer(variant, id) }));
    rows.push({ id: expectation.id, defect: expectation.defect, gate: variant.gate, baseGate: base.gate,
      caught: targets.some(target => target.variant !== undefined && target.variant.score !== null &&
        (target.base === undefined || target.base.score === null || target.variant.score < target.base.score)),
      targets: targets.map(target => ({ id: target.id, base: target.base?.answer ?? null, variant: target.variant?.answer ?? null })) });
  }
  for (const id of clean) if (!Object.hasOwn(results, id)) missing.push(id);
  const bases = [...new Set([...expectations.map(expectation => expectation.base), ...clean])].filter(id => Object.hasOwn(results, id));
  const cleanBasesFailing = bases.filter(id => results[id]!.gate !== 'pass');
  const targeted = new Set(expectations.flatMap(expectation => expectation.targets));
  const cleanFalseAlarms = bases.flatMap(id => results[id]!.answers.filter(entry => targeted.has(entry.id) && entry.status === 'ok' && entry.passed === false)
    .map(entry => ({ output: id, question: entry.id, answer: entry.answer })));
  const required = expectations.filter(expectation => expectation.gate_must_fail);
  const gateFailed = required.filter(expectation => rows.find(row => row.id === expectation.id)?.gate === 'fail').length;
  const caught = rows.filter(row => row.caught).length;
  return { defects: expectations.length, caught, gateRequired: required.length, gateFailed, cleanBases: bases.length, cleanBasesFailing, cleanFalseAlarms, missing: [...new Set(missing)], rows,
    ok: missing.length === 0 && caught === expectations.length && gateFailed === required.length && cleanBasesFailing.length === 0 && cleanFalseAlarms.length === 0 };
}
