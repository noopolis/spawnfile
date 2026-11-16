import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CheckNode, Stage } from '../../contracts/dataset.js';
import type { ArtifactSnapshot, EvaluationContext, EvaluationRegistry, EvaluationSnapshot } from '../../contracts/evaluation.js';
import { reviewCandidate, type CriticReview } from '../../critic/index.js';
import { evaluatePlan } from '../../evaluation/index.js';
import { calibrationExpectationSchema, checkQuestionnaireCalibration, summarizeQuestionnaire,
  type CalibrationExpectation, type CalibrationReport, type QuestionnaireResult, type QuestionnaireSummary } from '../../questionnaire/index.js';

export const REGRADE_SCHEMA = 'spawnfile.training.regrade.v1' as const;
const name = z.string().regex(/^[A-Za-z0-9._-]+$/u);
const relative = z.string().min(1).refine(value => !value.startsWith('/') && !value.includes('\\') && !value.split('/').includes('..'), 'expected a contained relative path');

/** Recorded outputs to grade again with one declared check. Paths are relative to the manifest. */
export const regradeManifestSchema = z.strictObject({
  schema: z.literal(REGRADE_SCHEMA),
  check: z.object({ id: name, eval: z.literal('questionnaire'), bank: relative, input: z.literal('artifact:output'),
    context: z.record(z.string(), z.string()).optional() }).strict(),
  judges: z.record(name, z.strictObject({ provider: z.string().min(1), model: z.string().min(1), reasoning_effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional() })),
  calibration: relative.optional(),
  /** Recorded candidate prompts to put through the prompt critic, each against the recorded baseline. */
  critic: z.strictObject({
    judge: name, guide: z.array(relative).min(1), block_on: z.enum(['low', 'medium', 'high']).optional(),
    /** A text file describing the declared checks, shown to the critic as written. */
    checks: relative.optional(),
    /** Train case texts only. */
    train_cases: z.array(z.strictObject({ id: z.string().min(1), file: relative })).optional(),
    /** Editable documents by their path in the prompt. */
    baseline: z.record(z.string().min(1), relative),
    candidates: z.record(name, z.record(z.string().min(1), relative)),
  }).optional(),
  outputs: z.array(z.strictObject({
    id: name, candidate: z.string().min(1), case: z.string().min(1),
    /** The recorded output, or null when the subject left none: a measured zero, like a failed filing in a trial. */
    output: relative.nullable(),
    /** Calibration material, kept out of candidate comparisons. */
    calibration: z.boolean().optional(),
    context: z.record(z.string().regex(/^[A-Za-z_][\w-]*$/u), relative).optional(),
  })),
}).superRefine((manifest, context) => {
  if (manifest.outputs.length === 0 && !manifest.critic) context.addIssue({ code: 'custom', path: ['outputs'], message: 'a regrade needs outputs or a critic review' });
  if (manifest.critic && !Object.hasOwn(manifest.judges, manifest.critic.judge)) context.addIssue({ code: 'custom', path: ['critic', 'judge'], message: 'critic names an undeclared judge' });
  const ids = manifest.outputs.map(output => output.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', path: ['outputs'], message: 'output ids must be unique' });
});
export type RegradeManifest = z.infer<typeof regradeManifestSchema>;

export interface RegradedOutput {
  id: string; candidate: string; case: string; calibration: boolean;
  status: 'pass' | 'fail' | 'error' | 'unknown' | 'skipped';
  /** The check's score as the stage counts it; a missing output is 0. */
  score: number | null;
  reason: string;
  questionnaire?: QuestionnaireResult;
}
export interface RegradeCandidate {
  outputs: number; missing: number; errors: number;
  /** Means over every case, a missing output counted as 0 on each score. */
  score: number | null;
  /** Mean graded search score (the bank's ladder; the strict zero without one). */
  search: number | null;
  /** Share of cases whose output exists and passes every gate. */
  acceptance: number | null; scoreOpen: number | null; scoreHidden: number | null; gap: number | null;
  gatePassed: number;
  /** Over the outputs that exist. */
  graded: QuestionnaireSummary;
}
export interface RegradeReport {
  schema: 'spawnfile.training.regrade-report.v1';
  check: string; bank: { id: string; digest: string };
  judgeCalls: number;
  candidates: Record<string, RegradeCandidate>;
  calibration?: CalibrationReport;
  /** Critic reviews of recorded candidate prompts, by candidate label. */
  critic?: Record<string, CriticReview>;
  outputs: Omit<RegradedOutput, 'questionnaire'>[];
}
export interface RegradeOptions {
  manifest: RegradeManifest;
  /** Reads a manifest-relative file. */
  read: (path: string) => Promise<string>;
  evaluation: Pick<EvaluationContext, 'judges' | 'observeJudgeAttempt'>;
  registry: EvaluationRegistry;
  /** Calibration expectations given directly instead of through the manifest's `calibration` file, with further clean outputs. */
  expectations?: { expect: readonly CalibrationExpectation[]; clean?: readonly string[] };
  /** Results an earlier pass already holds; these outputs are not asked again. */
  completed?: Readonly<Record<string, RegradedOutput>>;
  /** Reviews an earlier pass already holds; these candidates are not reviewed again. */
  reviewed?: Readonly<Record<string, CriticReview>>;
  onReview?: (label: string, review: CriticReview) => void | Promise<void>;
  onResult?: (result: RegradedOutput) => void | Promise<void>;
  /** Outputs judged at once; 1 when omitted. */
  concurrency?: number;
  signal?: AbortSignal;
}

const round = (value: number): number => Math.round(value * 10_000) / 10_000;
const mean = (values: readonly number[]): number | null => values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
const data = (path: string, text: string): unknown => path.endsWith('.json') ? JSON.parse(text) as unknown : text;

function summarize(results: readonly RegradedOutput[]): RegradeCandidate {
  const graded = results.flatMap(result => result.questionnaire ? [result.questionnaire] : []);
  const missing = results.filter(result => !result.questionnaire && result.status === 'fail').length;
  const zeros = Array.from({ length: missing }, () => 0);
  const known = (pick: (result: QuestionnaireResult) => number | null) => graded.map(pick).filter((value): value is number => value !== null);
  const scoreOpen = mean([...known(result => result.scoreOpen), ...zeros]), scoreHidden = mean([...known(result => result.scoreHidden), ...zeros]);
  return { outputs: results.length, missing, errors: results.filter(result => result.status === 'error' || result.status === 'unknown').length,
    score: mean([...known(result => result.score), ...zeros]), search: mean([...known(result => result.search ?? null), ...zeros]),
    acceptance: results.length ? round(graded.filter(result => result.gate === 'pass').length / results.length) : null, scoreOpen, scoreHidden,
    gap: scoreOpen === null || scoreHidden === null ? null : round(scoreOpen - scoreHidden),
    gatePassed: graded.filter(result => result.gate === 'pass').length, graded: summarizeQuestionnaire(graded) };
}

async function reviewRecorded(options: RegradeOptions, critic: NonNullable<RegradeManifest['critic']>): Promise<Record<string, CriticReview>> {
  const route = Object.hasOwn(options.evaluation.judges, critic.judge) ? options.evaluation.judges[critic.judge] : undefined;
  if (!route) throw new Error(`Critic judge ${critic.judge} has no configured route`);
  const documents = async (files: Readonly<Record<string, string>>) => Object.fromEntries(await Promise.all(Object.entries(files).map(async ([path, file]) => [path, await options.read(file)] as const)));
  const baseline = await documents(critic.baseline);
  const guide = await Promise.all(critic.guide.map(async file => ({ name: file.split('/').at(-1)!, text: await options.read(file) })));
  const checks = critic.checks === undefined ? undefined : await options.read(critic.checks);
  const trainCases = critic.train_cases === undefined ? undefined : await Promise.all(critic.train_cases.map(async entry => ({ id: entry.id, text: await options.read(entry.file) })));
  const reviews: Record<string, CriticReview> = {};
  for (const [label, files] of Object.entries(critic.candidates)) {
    options.signal?.throwIfAborted();
    const done = options.reviewed && Object.hasOwn(options.reviewed, label) ? options.reviewed[label] : undefined;
    reviews[label] = done ?? await reviewCandidate({ baseline, candidate: await documents(files), guide, judge: { name: critic.judge, provider: route.provider, model: route.model },
      ...(critic.block_on ? { blockOn: critic.block_on } : {}), ...(checks === undefined ? {} : { checks }), ...(trainCases ? { trainCases } : {}), signal: options.signal });
    if (!done) await options.onReview?.(label, reviews[label]!);
  }
  return reviews;
}

/**
 * Grades recorded outputs through the registered check, on the run's judge routes, without any subject
 * trial: each output becomes a closed snapshot holding only that artifact and its bound context, and the
 * check runs through the same engine, score and gate a trial's stage would use.
 */
export async function regradeRecordedOutputs(options: RegradeOptions): Promise<RegradeReport> {
  const { manifest } = options;
  const check = manifest.check as CheckNode;
  const { id: _id, eval: _eval, ...parameters } = check;
  options.registry.questionnaire!.definition.validate(parameters, 'check');
  const bank = await options.read(manifest.check.bank);
  const stages: Stage[] = [{ id: 'regrade', checks: [check], score: { linear: { [manifest.check.id]: 1 } }, gate: { all: [{ passed: manifest.check.id }] } }];
  const grade = async (entry: RegradeManifest['outputs'][number]): Promise<RegradedOutput> => {
    options.signal?.throwIfAborted();
    const done = options.completed && Object.hasOwn(options.completed, entry.id) ? options.completed[entry.id] : undefined;
    if (done) return done;
    const context: Record<string, unknown> = {};
    for (const [key, path] of Object.entries(entry.context ?? {})) context[key] = data(path, await options.read(path));
    const artifacts: Record<string, ArtifactSnapshot> = {};
    if (entry.output !== null) {
      const bytes = await options.read(entry.output);
      artifacts.output = { name: 'output', checkpointId: `regrade:${entry.id}`, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        bytes, value: data(entry.output, bytes), provenance: 'recorded output' };
    }
    // A recorded set is complete by declaration: an output listed as absent is an observed absence.
    const snapshot: EvaluationSnapshot = { trialId: `regrade:${entry.id}`, recordId: entry.case, closed: true, events: [], coverage: [], artifacts,
      output: '', inputFiles: {}, context: context as EvaluationSnapshot['context'], subjectUsage: { status: 'incomplete', usage: null, settled: true } };
    const plan = await evaluatePlan(stages, { snapshot, results: {}, scores: {}, embeddings: {}, judges: options.evaluation.judges,
      observeJudgeAttempt: options.evaluation.observeJudgeAttempt, signal: options.signal,
      readText: async path => { if (path !== manifest.check.bank) throw new Error(`Unfrozen criterion sidecar: ${path}`); return bank; } }, options.registry);
    const evaluated = plan.checks[manifest.check.id]!;
    const result: RegradedOutput = { id: entry.id, candidate: entry.candidate, case: entry.case, calibration: entry.calibration === true, status: evaluated.status,
      score: evaluated.score ?? null, reason: evaluated.reason, ...(evaluated.questionnaire ? { questionnaire: evaluated.questionnaire } : {}) };
    await options.onResult?.(result);
    return result;
  };
  // Outputs are independent: up to `concurrency` are judged at once, and results keep the manifest's order.
  const results = new Array<RegradedOutput>(manifest.outputs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 1, manifest.outputs.length)) }, async () => {
    while (next < manifest.outputs.length) { const index = next++; results[index] = await grade(manifest.outputs[index]!); }
  }));
  const bankId = results.find(result => result.questionnaire)?.questionnaire!.bank.id ?? '';
  const critic = manifest.critic ? await reviewRecorded(options, manifest.critic) : undefined;
  const candidates: Record<string, RegradeCandidate> = {};
  for (const label of [...new Set(results.filter(result => !result.calibration).map(result => result.candidate))]) {
    candidates[label] = summarize(results.filter(result => !result.calibration && result.candidate === label));
  }
  const graded = Object.fromEntries(results.flatMap(result => result.questionnaire ? [[result.id, result.questionnaire]] : []));
  const calibration = options.expectations ? checkQuestionnaireCalibration(options.expectations.expect, graded, options.expectations.clean)
    : manifest.calibration === undefined ? undefined
    : checkQuestionnaireCalibration(calibrationExpectationSchema.parse(JSON.parse(await options.read(manifest.calibration))), graded);
  return { schema: 'spawnfile.training.regrade-report.v1', check: manifest.check.id,
    bank: { id: bankId, digest: `sha256:${createHash('sha256').update(bank).digest('hex')}` },
    judgeCalls: results.reduce((sum, result) => sum + (result.questionnaire?.judgeCalls.length ?? 0), 0), candidates,
    ...(calibration ? { calibration } : {}), ...(critic ? { critic } : {}), outputs: results.map(({ questionnaire: _questionnaire, ...rest }) => rest) };
}
