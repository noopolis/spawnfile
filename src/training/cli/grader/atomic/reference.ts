import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stableDigest } from '../../../graders/index.js';
import { instantiateChecks } from '../../../graders/decomposition/index.js';
import { generateTraps } from '../../../graders/traps/index.js';
import { runCouncil, referenceQuality, type CouncilOutput, type TrapAssessment } from '../../../graders/references/index.js';
import type { GraderDependencies } from '../backend.js';
import { createGraderTeacher } from '../label-call.js';
import { selectTeachers } from './decompose.js';
import { atomicWrite, readDecompositions, readOptional, readTemplates, workers } from './files.js';

export interface ReferenceOptions {
  templatesFile: string; decompositions: string; traps?: string; teachers: string[];
  out: string; concurrency?: number; timeoutMs?: number; signal?: AbortSignal; now?: Date;
}
type TrapBundle = ReturnType<typeof generateTraps> & { decomposition: string; decompositionDigest: string };
export async function runReference(options: ReferenceOptions, dependencies: GraderDependencies = {}) {
  options.signal?.throwIfAborted();
  const templates = await readTemplates(options.templatesFile);
  const teachers = selectTeachers(templates, options.teachers);
  const inputs = await readDecompositions(options.decompositions, templates);
  const trapBundles: TrapBundle[] = [];
  if (options.traps) {
    const files = (await readdir(options.traps)).filter(file => file.endsWith('.traps.json')).sort();
    for (const file of files) {
      const bundle = JSON.parse(await readFile(join(options.traps, file), 'utf8')) as TrapBundle;
      if (trapBundles.some(previous => previous.decomposition === bundle.decomposition)) throw new Error(`Duplicate trap decomposition: ${file}`);
      const input = inputs.find(input => input.file === bundle.decomposition);
      if (!input || input.digest !== bundle.decompositionDigest) throw new Error(`Stale trap decomposition: ${file}`);
      const regenerated = generateTraps(templates, input.doc, input.inputs, { seed: bundle.seed });
      if (stableDigest(bundle.traps) !== stableDigest(regenerated.traps)) throw new Error(`Invalid trap checkpoint: ${file}`);
      trapBundles.push(bundle);
    }
  }
  const providers = Object.fromEntries(teachers.map(teacher => [teacher.id, (dependencies.provider ?? createGraderTeacher)(teacher)]));
  const outputs: Record<string, CouncilOutput> = {};
  const checkpoints = `${options.out}.checkpoints`;
  const run = async (key: string, outputDigest: string, instances: Parameters<typeof runCouncil>[0]['instances']) => {
    options.signal?.throwIfAborted();
    const filename = join(checkpoints, `${stableDigest(key)}.json`);
    const previous = await readOptional<CouncilOutput>(filename);
    outputs[key] = await runCouncil({ outputDigest, instances, teachers, providers, previous,
      now: options.now, grokWindow: templates.grok_window, timeoutMs: options.timeoutMs, signal: options.signal,
      onCheckpoint: output => atomicWrite(filename, output) });
  };
  await workers(inputs, options.concurrency ?? 2, async input => {
    await run(input.file, input.digest, instantiateChecks(templates, input.doc, input.inputs));
    for (const bundle of trapBundles.filter(bundle => bundle.decomposition === input.file)) {
      for (const trap of bundle.traps) await run(`${input.file}:${trap.id}`, stableDigest({ base: input.digest, trap }), trap.instances);
    }
  }, options.signal);
  const assessments: TrapAssessment[] = [];
  for (const bundle of trapBundles) for (const trap of bundle.traps) {
    const base = outputs[bundle.decomposition]!, variant = outputs[`${bundle.decomposition}:${trap.id}`]!;
    for (const [id, intended] of Object.entries(trap.intended_answers)) assessments.push({
      kind: trap.kind, templateId: trap.instances.find(instance => instance.id === id)!.template_id,
      intended, actual: variant.checks[id]?.final ?? null, baseline: base.checks[id]?.final ?? null,
    });
  }
  const sorted = Object.fromEntries(Object.entries(outputs).sort(([a], [b]) => a.localeCompare(b)));
  const quality = referenceQuality(Object.values(sorted), assessments);
  const artifact = { schema: 'paideia.references.v1', templatesDigest: stableDigest(templates), outputs: sorted, quality };
  await atomicWrite(options.out, { ...artifact, digest: stableDigest(artifact) });
  const reportFile = `${options.out}.md`;
  await atomicWrite(reportFile, referenceReport(artifact));
  return { file: options.out, reportFile, outputs: Object.keys(outputs).length, ...quality };
}
function referenceReport(artifact: { outputs: Record<string, CouncilOutput>; quality: ReturnType<typeof referenceQuality> }): string {
  const { quality } = artifact;
  const skipped = [...new Set(Object.values(artifact.outputs).flatMap(output => output.skipped.map(skip => `${skip.teacher}: ${skip.reason}`)))];
  const calls = Object.values(artifact.outputs).flatMap(output => output.calls);
  return [`# Council references: ${quality.gate}`, '',
    `Constructed-control accuracy: ${quality.overall.accuracy === null ? 'unmeasured (no validated traps)' : `${(quality.overall.accuracy * 100).toFixed(2)}%`} (${quality.overall.correct}/${quality.overall.total}).`,
    `Adjudication instability: ${(quality.instability.rate * 100).toFixed(2)}% (${quality.instability.unstable}/${quality.instability.items}).`,
    `Calls: ${calls.length}; recorded latency: ${calls.reduce((sum, call) => sum + call.wallMs, 0).toFixed(0)} ms. Usage and subscription accounting are recorded per call; unreported usage/cost remains unknown.`, '',
    ...quality.failures.map(failure => `- STOP: ${failure}`),
    ...quality.failingKinds.map(kind => `- Failing trap kind: ${kind}`),
    ...quality.failingTemplates.map(id => `- Failing template: ${id}`),
    ...skipped.map(skip => `- Skipped ${skip}`), '',
    'Trap accuracy by kind:', '', ...Object.entries(quality.byKind).map(([kind, score]) => `- ${kind}: ${score.correct}/${score.total}`), '',
    'Option-permutation consistency: ' + (quality.optionPermutation.accuracy === null ? 'unmeasured' : `${quality.optionPermutation.correct}/${quality.optionPermutation.total}`) + '.', '',
    'Teachers against references excluding themselves:', '',
    ...Object.entries(quality.teachers).map(([id, score]) => `- ${id}: ${(score.agreement * 100).toFixed(2)}% agreement on ${score.items} checks; soft agreement ${score.softAgreement.toFixed(4)}.`), '',
    'Agent agreement is not independent correctness. Known-answer traps measure constructed-control accuracy; external reviews and editor verdicts remain weak signals.', '',
  ].join('\n');
}
