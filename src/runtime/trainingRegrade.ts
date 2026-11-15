import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { createTrainingProviderRegistry } from "./trainingProviders.js";
import { SpawnfileError } from "../shared/index.js";
import { createEvaluationRegistry, inferenceProviderDescriptor, regradeManifestSchema, regradeRecordedOutputs,
  renderQuestionnaireMarkdown, type InferenceProvider, type JudgeRoute, type CriticReview, type RegradeReport, type RegradedOutput } from "../training/index.js";

export interface RegradeTrainingOptions {
  manifest: string;
  out: string;
  /** Bound on one judge call (default 15 minutes). */
  judgeTimeoutMs?: number;
  streams: { stdout: (line: string) => void; stderr: (line: string) => void };
  signal?: AbortSignal;
  /** The provider behind each declared judge (tests only); the registered provider otherwise. */
  provider?: (model: { provider: string; model: string; reasoning_effort?: string }) => InferenceProvider;
}

const invalid = (message: string): never => { throw new SpawnfileError("validation_error", message); };

export const renderRegradeMarkdown = (report: RegradeReport): string => {
  const calibration = report.calibration;
  return [`# Regrade: ${report.check}`, "", `Bank ${report.bank.id} (${report.bank.digest}). Recorded outputs only; no subject trial ran. Judge calls: ${report.judgeCalls}.`, "",
    "Scores in the first table count a missing output as 0. Operator-only: hidden questions are named below.", "",
    renderQuestionnaireMarkdown(Object.fromEntries(Object.entries(report.candidates).map(([label, candidate]) => [label,
      { summary: candidate.graded, score: candidate.score, scoreOpen: candidate.scoreOpen, scoreHidden: candidate.scoreHidden, gap: candidate.gap, missing: candidate.missing }]))), "",
    ...(calibration ? ["## Calibration", "",
      `Verdict: **${calibration.ok ? "pass" : "fail"}**. Defects caught ${calibration.caught} of ${calibration.defects}; required gates failed ${calibration.gateFailed} of ${calibration.gateRequired}; clean bases failing ${calibration.cleanBasesFailing.length} of ${calibration.cleanBases}${calibration.missing.length ? `; missing ${calibration.missing.join(", ")}` : ""}.`, "",
      ...calibration.rows.map((row) => `- ${row.defect}: ${row.caught ? "caught" : "MISSED"}, gate ${row.baseGate} to ${row.gate}; ${row.targets.map((target) => `${target.id} ${JSON.stringify(target.base)} to ${JSON.stringify(target.variant)}`).join("; ")}`), ""] : []),
    ...Object.entries(report.critic ?? {}).flatMap(([label, review]) => [`## Prompt critic: ${label}`, "",
      `Verdict: **${review.verdict}** (blocks on ${review.blockOn}). ${review.error ?? review.summary}`, "",
      ...review.findings.map((finding) => `- ${finding.category}, ${finding.severity}${finding.case ? `, case ${finding.case}` : ""}${finding.unverifiedQuote ? ", quote not found in the prompt" : ""}: "${finding.quoted_line.replace(/\s+/gu, " ")}". ${finding.why}`),
      ...(review.overlaps.length ? ["", "Added lines sharing uncommon terms with train cases:", ...review.overlaps.map((hit) => `- "${hit.line}": ${hit.cases.map((entry) => `${entry.id} (${entry.terms.join(", ")})`).join("; ")}`)] : []), ""]),
    "## Outputs", "", ...report.outputs.map((output) => `- ${output.id}: ${output.status}, score ${output.score ?? "n/a"} (${output.reason})`), ""].join("\n");
};

/**
 * Grades recorded outputs with one declared questionnaire check on the registered judge providers, the same
 * judge route a training run uses, and starts no subject. Results are kept one file per output under
 * `<out>/results`, so an interrupted regrade resumes without asking again. The caller binds the run's judges.
 */
export const regradeTraining = async (options: RegradeTrainingOptions): Promise<number> => {
  const manifestPath = path.resolve(options.manifest);
  const base = path.dirname(await realpath(manifestPath).catch(() => invalid(`Regrade manifest does not exist: ${options.manifest}`)));
  const parsed = regradeManifestSchema.safeParse(JSON.parse(await readFile(manifestPath, "utf8")));
  if (!parsed.success) return invalid(`Regrade manifest: ${parsed.error.issues[0]!.path.join(".")}: ${parsed.error.issues[0]!.message}`);
  const manifest = parsed.data;
  const out = path.resolve(options.out);
  const resultsDirectory = path.join(out, "results");
  await mkdir(resultsDirectory, { recursive: true });
  const completed: Record<string, RegradedOutput> = {};
  for (const file of await readdir(resultsDirectory)) {
    if (!file.endsWith(".json")) continue;
    const result = JSON.parse(await readFile(path.join(resultsDirectory, file), "utf8")) as RegradedOutput;
    // An output whose judge did not answer is asked again; a settled one never is.
    if (result.status === "pass" || result.status === "fail") completed[result.id] = result;
  }
  const reviewsDirectory = path.join(out, "critic");
  await mkdir(reviewsDirectory, { recursive: true });
  const reviewed: Record<string, CriticReview> = {};
  for (const file of await readdir(reviewsDirectory)) {
    if (!file.endsWith(".json")) continue;
    const review = JSON.parse(await readFile(path.join(reviewsDirectory, file), "utf8")) as CriticReview;
    if (review.verdict !== "error") reviewed[file.slice(0, -5)] = review;
  }
  const registry = createTrainingProviderRegistry();
  const resources = new Map<string, unknown>();
  const closers: (() => Promise<void>)[] = [];
  const judges: Record<string, JudgeRoute> = Object.fromEntries(Object.entries(manifest.judges).map(([name, model]) => {
    const descriptor = inferenceProviderDescriptor(registry, model.provider);
    descriptor.validate(model, `judges.${name}`);
    const provider = options.provider?.(model) ?? descriptor.create(model, { timeoutMs: options.judgeTimeoutMs ?? 900_000, purpose: "judge", resources,
      onClose: (close: () => Promise<void>) => { closers.push(close); } });
    return [name, { provider, model: model.model, ...(model.reasoning_effort === undefined ? {} : { effort: model.reasoning_effort }) }];
  }));
  try {
    const report = await regradeRecordedOutputs({ manifest, completed, reviewed, registry: createEvaluationRegistry(), evaluation: { judges }, signal: options.signal,
      read: async (file) => {
        const real = await realpath(path.resolve(base, file)).catch(() => invalid(`Regrade input does not exist: ${file}`));
        if (!real.startsWith(`${base}${path.sep}`)) invalid(`Regrade input leaves the manifest directory: ${file}`);
        return readFile(real, "utf8");
      },
      onReview: async (label, review) => {
        await writeFile(path.join(reviewsDirectory, `${label}.json`), `${JSON.stringify(review, null, 1)}\n`, { mode: 0o600 });
        options.streams.stderr(`reviewed ${label}: ${review.verdict}, ${review.findings.length} findings`);
      },
      onResult: async (result) => {
        await writeFile(path.join(resultsDirectory, `${result.id}.json`), `${JSON.stringify(result, null, 1)}\n`, { mode: 0o600 });
        options.streams.stderr(`regraded ${result.id}: ${result.status} ${result.score ?? "n/a"}`);
      } });
    await writeFile(path.join(out, "REGRADE.json"), `${JSON.stringify(report, null, 1)}\n`, { mode: 0o600 });
    await writeFile(path.join(out, "REGRADE.md"), renderRegradeMarkdown(report), { mode: 0o600 });
    options.streams.stdout(JSON.stringify({ schema: report.schema, out, judgeCalls: report.judgeCalls,
      candidates: Object.fromEntries(Object.entries(report.candidates).map(([label, candidate]) => [label, { score: candidate.score, scoreHidden: candidate.scoreHidden, gap: candidate.gap }])),
      ...(report.calibration ? { calibration: report.calibration.ok } : {}) }));
    const unsettled = report.outputs.some((output) => output.status !== "pass" && output.status !== "fail") ||
      Object.values(report.critic ?? {}).some((review) => review.verdict === "error");
    return unsettled || report.calibration?.ok === false ? 1 : 0;
  } finally {
    await Promise.all(closers.map((close) => close()));
  }
};
