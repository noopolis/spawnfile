import { randomUUID } from 'node:crypto';
import { graderProvider } from '../contracts/index.js';
import { createEvaluationRegistry, validateJudgeTemplate } from '../evaluation/index.js';
import { readTrialEval, rescoreWithCriteria } from '../experiments/replay/index.js';
import { decisionModels } from '../graders/index.js';
import { judgeCitationRepairs, pairs } from './arguments.js';
import { CliDatasets } from './datasets.js';
import { authoredArguments, createTrainingInference, judgeVersions } from './training/index.js';
import type { CliDependencies, CliIO } from './types.js';

/** Bind only the grading services needed by the selected captured record. */
export async function regradeWithDataset(file: string, criteria: string, io: CliIO,
  dependencies: Required<Pick<CliDependencies, 'inferenceProviders'>> & Pick<CliDependencies, 'modelInference'>,
  openJudges: (providers: string[]) => Promise<{ close(): Promise<void> } | undefined>,
  flags: Readonly<Record<string, readonly string[]>>, timeoutMs: number) {
  const capture = await readTrialEval(file);
  io.signal?.throwIfAborted();
  const registry = dependencies.inferenceProviders;
  const args = authoredArguments({ command: 'evaluate', dataset: criteria, flags }, io, registry);
  const declared = pairs(args.flags.judge ?? []);
  const versions = judgeVersions(args.training, undefined, Object.keys(declared), registry);
  const loader = new CliDatasets(declared, io.cwd, { inferenceProviders: registry }, versions, args.frozenDataset);
  const dataset = loader.loadCaptured(criteria, capture.report.recordId, Object.keys(capture.report.snapshot.artifacts));
  const judges = Object.fromEntries(Object.entries(declared).filter(([name]) => Object.hasOwn(dataset.registryVersions, 'judge:' + name)));
  const repairs = judgeCitationRepairs(args, declared);
  const providers = new Set<string>();
  for (const name of Object.keys(judges)) {
    const policy = args.training?.judges?.[name];
    if (policy) {
      if (policy.template) await validateJudgeTemplate(policy.template, io.signal);
      for (const key of [policy.model, ...policy.fallbacks ?? []]) providers.add(args.training!.models[key]!.provider);
    } else providers.add(registry.defaultProviderId);
  }
  const graders = await loader.buildGraders();
  for (const runtime of Object.values(graders)) {
    if ('kind' in runtime) providers.add(graderProvider(runtime.grader.extractor.provider).inferenceProviderId);
    else {
      const teachers = new Set(decisionModels(runtime.grader).flatMap(model => model.backend === 'teacher' ? [model.teacher] : []));
      if (runtime.teacher) teachers.add(runtime.grader.escalate.to);
      for (const teacher of runtime.grader.teachers) if (teachers.has(teacher.id)) providers.add(graderProvider(teacher.provider).inferenceProviderId);
    }
  }
  const host = await openJudges([...providers]);
  try {
    const routes = createTrainingInference(args, dependencies, timeoutMs, judges, repairs, true);
    try {
      return await rescoreWithCriteria(capture.report, { id: capture.evaluationId, digest: capture.evaluationDigest },
        { id: 'regrade:' + randomUUID(), dataset, registry: createEvaluationRegistry(), requireConfirmedClosure: true, signal: io.signal,
          evaluation: { judges: routes.judges, graders, embeddings: {}, readText: name => loader.readCriterion(name) } });
    } finally { await routes.close(); }
  } finally { await host?.close(); }
}
