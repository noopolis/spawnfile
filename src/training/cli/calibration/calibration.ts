import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { CheckNode, ResolvedDataset } from '../../contracts/dataset.js';
import type { EvaluationContext, EvaluationRegistry, JudgeCall } from '../../contracts/evaluation.js';
import { REGRADE_SCHEMA, regradeRecordedOutputs, type RegradedOutput } from '../../experiments/index.js';
import { calibrationSetSchema, QUESTIONNAIRE_PROMPT_VERSION, type CalibrationRun, type CalibrationSet } from '../../questionnaire/index.js';
import type { CliArguments } from '../arguments.js';
import { readCliText } from '../datasets.js';

/** One declared calibration set, read and bound to the frozen questionnaire check it calibrates. */
export interface LoadedCalibrationSet {
  /** The set file as declared, relative to the train dataset. */
  file: string;
  directory: string;
  set: CalibrationSet;
  check: CheckNode & { id: string; bank: string };
  bank: string;
  /** Binds the bank, the set and every file it names: a changed input is judged again, an unchanged one never. */
  digest: string;
  /** Judge calls the set asks, by judge route. */
  judgeCalls: Record<string, number>;
}

export type TrainingCalibration = CalibrationRun;

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

function questionnaireCheck(train: ResolvedDataset, id: string, file: string): LoadedCalibrationSet['check'] {
  const found = new Map<string, CheckNode>();
  const visit = (node: CheckNode) => {
    if (node.eval === 'questionnaire' && node.id === id) found.set(JSON.stringify([node.bank, node.context ?? {}]), node);
    [...node.all ?? [], ...node.any ?? [], ...node.not ? [node.not] : []].forEach(visit);
  };
  for (const record of train.records) for (const stage of record.effectiveStages) stage.checks.forEach(visit);
  if (found.size === 0) throw new Error(`Calibration set ${file} names check ${id}, which is not a questionnaire check of the train dataset`);
  if (found.size > 1) throw new Error(`Calibration set ${file}: check ${id} uses more than one bank or context binding across train records`);
  const node = [...found.values()][0]!;
  return { id, eval: 'questionnaire', bank: node.bank as string, input: 'artifact:output', ...(node.context ? { context: structuredClone(node.context) } : {}) };
}

/** Reads the declared calibration sets beside the train dataset. Pure file reads: no judge is asked. */
export function loadCalibrationSets(args: CliArguments, train: ResolvedDataset): LoadedCalibrationSet[] {
  const files = args.training?.calibration ?? [];
  if (!files.length) return [];
  const base = dirname(args.frozenDataset!.path);
  return files.map(file => {
    const path = resolve(base, file), directory = dirname(path);
    const text = readCliText(path, 2_000_000);
    let parsed;
    try { parsed = calibrationSetSchema.safeParse(JSON.parse(text)); } catch { throw new Error(`Calibration set ${file} is not JSON`); }
    if (!parsed.success) throw new Error(`Calibration set ${file}: ${parsed.error.issues[0]!.path.join('.')}: ${parsed.error.issues[0]!.message}`);
    const set = parsed.data;
    const check = questionnaireCheck(train, set.check, file);
    const bank = readCliText(resolve(base, check.bank), 2_000_000);
    if (train.criterionFileDigests[check.bank] !== `sha256:${sha(bank)}`) throw new Error(`Calibration set ${file}: bank ${check.bank} differs from the frozen train dataset`);
    const bound = Object.keys((check.context ?? {}) as Record<string, string>).sort();
    for (const output of set.outputs) {
      const given = Object.keys(output.context ?? {}).sort();
      if (JSON.stringify(given) !== JSON.stringify(bound)) throw new Error(`Calibration set ${file}: output ${output.id} must bind exactly the check's context (${bound.join(', ') || 'none'})`);
    }
    const inputs = set.outputs.flatMap(output => [output.output, ...Object.values(output.context ?? {})]);
    const digest = sha(JSON.stringify([QUESTIONNAIRE_PROMPT_VERSION, sha(bank), set, [...new Set(inputs)].sort().map(input => [input, sha(readCliText(resolve(directory, input), 8_000_000))])]));
    const perOutput = train.questionnaireCalls?.[check.bank] ?? {};
    return { file, directory, set, check, bank, digest,
      judgeCalls: Object.fromEntries(Object.entries(perOutput).map(([judge, calls]) => [judge, calls * set.outputs.length])) };
  });
}

/** Calibration judge calls by route, for the cost plan. */
export function calibrationCalls(sets: readonly LoadedCalibrationSet[]): Record<string, number> {
  const calls: Record<string, number> = {};
  for (const set of sets) for (const [judge, count] of Object.entries(set.judgeCalls)) calls[judge] = (calls[judge] ?? 0) + count;
  return calls;
}

/**
 * Judges every declared calibration set on the run's own judge routes before any trial. Results are kept one
 * file per output under `<out>/calibration/<set>-<digest>`, so a resumed run asks only for outputs whose judge
 * has not answered. A set the bank misses refuses the run: the thrown error is the refusal.
 */
export async function runTrainingCalibration(options: {
  sets: readonly LoadedCalibrationSet[];
  out: string;
  evaluation: Pick<EvaluationContext, 'judges' | 'observeJudgeAttempt'>;
  registry: EvaluationRegistry;
  concurrency?: number;
  signal?: AbortSignal;
  observe?: (event: { type: 'calibration.judged'; payload: { status: 'pass' | 'fail'; set: string; judgeCalls: JudgeCall[] } }) => void | Promise<void>;
}): Promise<TrainingCalibration[]> {
  const reports: TrainingCalibration[] = [];
  for (const loaded of options.sets) {
    const directory = join(options.out, 'calibration', `${basename(loaded.file).replace(/\.[^.]+$/u, '').replace(/[^A-Za-z0-9._-]/gu, '_')}-${loaded.digest.slice(0, 12)}`);
    const results = join(directory, 'results');
    await mkdir(results, { recursive: true, mode: 0o700 });
    const completed: Record<string, RegradedOutput> = {};
    for (const file of await readdir(results)) {
      if (!file.endsWith('.json')) continue;
      const result = JSON.parse(await readFile(join(results, file), 'utf8')) as RegradedOutput;
      // An output whose judge did not answer is asked again; a settled one never is.
      if (result.status === 'pass' || result.status === 'fail') completed[result.id] = result;
    }
    let asked = 0;
    const settled: RegradedOutput[] = [];
    const report = await regradeRecordedOutputs({
      manifest: { schema: REGRADE_SCHEMA, check: loaded.check as never, judges: {},
        outputs: loaded.set.outputs.map(output => ({ id: output.id, candidate: 'calibration', case: output.id, output: output.output, calibration: true, ...(output.context ? { context: output.context } : {}) })) },
      expectations: { expect: loaded.set.expect ?? [], clean: loaded.set.clean },
      completed, registry: options.registry, evaluation: options.evaluation, concurrency: options.concurrency, signal: options.signal,
      read: async path => {
        if (path === loaded.check.bank) return loaded.bank;
        const file = resolve(loaded.directory, path);
        if (!file.startsWith(`${loaded.directory}${sep}`)) throw new Error(`Calibration input leaves its set: ${path}`);
        return readCliText(file, 8_000_000);
      },
      onResult: async result => {
        asked += result.questionnaire?.judgeCalls.length ?? 0;
        settled.push(result);
        await writeFile(join(results, `${result.id}.json`), `${JSON.stringify(result, null, 1)}\n`, { mode: 0o600 });
      } });
    const calibration = report.calibration!;
    const entry: TrainingCalibration = { set: loaded.file, check: loaded.set.check, bank: report.bank, outputs: loaded.set.outputs.length, judgeCallsAsked: asked, report: calibration };
    await writeFile(join(directory, 'CALIBRATION.json'), `${JSON.stringify(entry, null, 1)}\n`, { mode: 0o600 });
    reports.push(entry);
    await options.observe?.({ type: 'calibration.judged', payload: { status: calibration.ok ? 'pass' : 'fail', set: loaded.file,
      judgeCalls: [...Object.values(completed), ...settled].flatMap(result => result.questionnaire?.judgeCalls ?? []) } });
    if (!calibration.ok) {
      const missed = calibration.rows.filter(row => !row.caught).map(row => row.defect);
      const unanswered = report.outputs.filter(output => output.status !== 'pass' && output.status !== 'fail').map(output => output.id);
      throw new Error(`Calibration refused the run: set ${loaded.file} on check ${loaded.set.check} caught ${calibration.caught} of ${calibration.defects} defects`
        + `${missed.length ? ` (missed ${missed.join(', ')})` : ''}, failed ${calibration.gateFailed} of ${calibration.gateRequired} required gates, `
        + `${calibration.cleanBasesFailing.length} of ${calibration.cleanBases} clean outputs fail a gate${calibration.cleanBasesFailing.length ? ` (${calibration.cleanBasesFailing.join(', ')})` : ''}`
        + `${unanswered.length ? `. The judge did not answer for ${unanswered.join(', ')}; a resumed run asks only for those` : ''}. No trial was started; see ${directory}`);
    }
  }
  return reports;
}
