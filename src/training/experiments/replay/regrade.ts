import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CheckNode, Stage } from '../../contracts/dataset.js';
import type { ArtifactSnapshot, EvaluationContext, EvaluationRegistry, EvaluationSnapshot } from '../../contracts/evaluation.js';
import { evaluatePlan } from '../../evaluation/index.js';
import { calibrationExpectationSchema, checkQuestionnaireCalibration, summarizeQuestionnaire,
  type CalibrationReport, type QuestionnaireResult, type QuestionnaireSummary } from '../../questionnaire/index.js';

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
  outputs: z.array(z.strictObject({
    id: name, candidate: z.string().min(1), case: z.string().min(1),
    /** The recorded output, or null when the subject left none: a measured zero, like a failed filing in a trial. */
    output: relative.nullable(),
    /** Calibration material, kept out of candidate comparisons. */
    calibration: z.boolean().optional(),
    context: z.record(z.string().regex(/^[A-Za-z_][\w-]*$/u), relative).optional(),
  })).min(1),
}).superRefine((manifest, context) => {
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
  score: number | null; scoreOpen: number | null; scoreHidden: number | null; gap: number | null;
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
  outputs: Omit<RegradedOutput, 'questionnaire'>[];
}
export interface RegradeOptions {
  manifest: RegradeManifest;
  /** Reads a manifest-relative file. */
  read: (path: string) => Promise<string>;
  evaluation: Pick<EvaluationContext, 'judges' | 'observeJudgeAttempt'>;
  registry: EvaluationRegistry;
  /** Results an earlier pass already holds; these outputs are not asked again. */
  completed?: Readonly<Record<string, RegradedOutput>>;
  onResult?: (result: RegradedOutput) => void | Promise<void>;
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
    score: mean([...known(result => result.score), ...zeros]), scoreOpen, scoreHidden,
    gap: scoreOpen === null || scoreHidden === null ? null : round(scoreOpen - scoreHidden),
    gatePassed: graded.filter(result => result.gate === 'pass').length, graded: summarizeQuestionnaire(graded) };
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
  const results: RegradedOutput[] = [];
  let bankId = '';
  for (const entry of manifest.outputs) {
    options.signal?.throwIfAborted();
    const done = options.completed && Object.hasOwn(options.completed, entry.id) ? options.completed[entry.id] : undefined;
    if (done) { results.push(done); bankId ||= done.questionnaire?.bank.id ?? ''; continue; }
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
    bankId ||= evaluated.questionnaire?.bank.id ?? '';
    results.push(result);
    await options.onResult?.(result);
  }
  const candidates: Record<string, RegradeCandidate> = {};
  for (const label of [...new Set(results.filter(result => !result.calibration).map(result => result.candidate))]) {
    candidates[label] = summarize(results.filter(result => !result.calibration && result.candidate === label));
  }
  const graded = Object.fromEntries(results.flatMap(result => result.questionnaire ? [[result.id, result.questionnaire]] : []));
  const calibration = manifest.calibration === undefined ? undefined
    : checkQuestionnaireCalibration(calibrationExpectationSchema.parse(JSON.parse(await options.read(manifest.calibration))), graded);
  return { schema: 'spawnfile.training.regrade-report.v1', check: manifest.check.id,
    bank: { id: bankId, digest: `sha256:${createHash('sha256').update(bank).digest('hex')}` },
    judgeCalls: results.reduce((sum, result) => sum + (result.questionnaire?.judgeCalls.length ?? 0), 0), candidates,
    ...(calibration ? { calibration } : {}), outputs: results.map(({ questionnaire: _questionnaire, ...rest }) => rest) };
}
