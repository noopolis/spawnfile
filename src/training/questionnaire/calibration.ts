import { z } from 'zod';
import type { QuestionnaireResult } from './run.js';

/** One output with a single injected defect, the clean output it was made from, and what the bank must do with it. */
export const calibrationExpectationSchema = z.array(z.object({
  id: z.string().min(1), base: z.string().min(1), defect: z.string().min(1), injected: z.string().optional(),
  targets: z.array(z.string().min(1)).min(1), gate_must_fail: z.boolean(),
}).strict()).min(1);
export type CalibrationExpectation = z.infer<typeof calibrationExpectationSchema>[number];

export interface CalibrationReport {
  defects: number;
  /** A target question scored lower on the variant than on its clean base. */
  caught: number;
  gateRequired: number;
  gateFailed: number;
  cleanBases: number;
  cleanBasesFailing: string[];
  missing: string[];
  rows: { id: string; defect: string; caught: boolean; gate: string; baseGate: string; targets: { id: string; base: unknown; variant: unknown }[] }[];
  /** Every defect caught, every required gate failed, no clean base failing, nothing missing. */
  ok: boolean;
}

/** Compares graded results against a bank's calibration set. Pure: it never asks a judge. */
export function checkQuestionnaireCalibration(expectations: readonly CalibrationExpectation[],
  results: Readonly<Record<string, QuestionnaireResult>>): CalibrationReport {
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
  const bases = [...new Set(expectations.map(expectation => expectation.base))].filter(id => Object.hasOwn(results, id));
  const cleanBasesFailing = bases.filter(id => results[id]!.gate !== 'pass');
  const required = expectations.filter(expectation => expectation.gate_must_fail);
  const gateFailed = required.filter(expectation => rows.find(row => row.id === expectation.id)?.gate === 'fail').length;
  const caught = rows.filter(row => row.caught).length;
  return { defects: expectations.length, caught, gateRequired: required.length, gateFailed, cleanBases: bases.length, cleanBasesFailing, missing: [...new Set(missing)], rows,
    ok: missing.length === 0 && caught === expectations.length && gateFailed === required.length && cleanBasesFailing.length === 0 };
}
