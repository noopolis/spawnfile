import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stableDigest } from '../../../graders/index.js';
import { instantiateChecks, trapDeclaration } from '../../../graders/decomposition/index.js';
import { validateTrap, type TrapSet } from '../../../graders/traps/index.js';
import { runCouncil, referenceQuality, type CouncilOutput, type TrapAssessment } from '../../../graders/references/index.js';
import type { GraderDependencies } from '../backend.js';
import { createGraderTeacher } from '../label-call.js';
import { selectTeachers } from './decompose.js';
import { atomicWrite, readDecompositions, readOptional, readTemplates, workers } from './files.js';

export interface ReferenceOptions {
  templatesFile: string; decompositions: string; traps?: string; teachers: string[];
  out: string; allowRejections?: boolean; concurrency?: number; batchSize?: number; timeoutMs?: number; signal?: AbortSignal; now?: Date;
}
type TrapBundle = TrapSet & { decomposition: string; decompositionDigest: string };
export async function runReference(options: ReferenceOptions, dependencies: GraderDependencies = {}) {
  options.signal?.throwIfAborted();
  const templates = await readTemplates(options.templatesFile);
  const teachers = selectTeachers(templates, options.teachers);
  const inputs = await readDecompositions(options.decompositions, templates, options.allowRejections);
  const trapBundles: TrapBundle[] = [];
  if (options.traps) {
    const files = (await readdir(options.traps)).filter(file => file.endsWith('.traps.json')).sort();
    for (const file of files) {
      const bundle = JSON.parse(await readFile(join(options.traps, file), 'utf8')) as TrapBundle;
      if (trapBundles.some(previous => previous.decomposition === bundle.decomposition)) throw new Error(`Duplicate trap decomposition: ${file}`);
      const input = inputs.find(input => input.file === bundle.decomposition);
      if (!input || input.digest !== bundle.decompositionDigest) throw new Error(`Stale trap decomposition: ${file}`);
      const units = [...input.doc.units, ...(input.doc.audit?.missed ?? [])];
      const ids = new Set<string>();
      for (const trap of bundle.traps) {
        const unit = units.find(unit => unit.id === trap.base_unit);
        if (ids.has(trap.id) || !unit || !validateTrap(trap, unit, input.inputs, templates, input.doc).valid) {
          throw new Error(`Invalid trap checkpoint: ${file}`);
        }
        ids.add(trap.id);
      }
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
      batchSize: options.batchSize, now: options.now, grokWindow: templates.grok_window, timeoutMs: options.timeoutMs, signal: options.signal,
      onCheckpoint: output => atomicWrite(filename, output) });
  };
  await workers(inputs, options.concurrency ?? 2, async input => {
    await run(input.file, input.digest, instantiateChecks(templates, input.doc, input.inputs));
    for (const bundle of trapBundles.filter(bundle => bundle.decomposition === input.file)) {
      for (const trap of bundle.traps) {
        const affected = trap.instances.filter(instance => Object.hasOwn(trap.intended_answers, instance.id));
        if (!['format-paraphrase', 'option-permutation'].includes(trap.kind) && affected.some(instance =>
          !instance.expected.includes(outputs[input.file]!.checks[instance.id]?.final ?? ''))) continue;
        await run(`${input.file}:${trap.id}`, stableDigest({ base: input.digest, trap }),
        affected);
      }
    }
  }, options.signal);
  const assessments: TrapAssessment[] = [];
  for (const bundle of trapBundles) for (const trap of bundle.traps) {
    const base = outputs[bundle.decomposition]!, variant = outputs[`${bundle.decomposition}:${trap.id}`]!;
    if (!variant) continue;
    for (const [id, intended] of Object.entries(trap.intended_answers)) {
      const templateId = trap.instances.find(instance => instance.id === id)!.template_id;
      const declaration = templates.templates.find(template => template.id === templateId)!.traps![trap.kind]!;
      assessments.push({
        known_answer: trapDeclaration(declaration).known_answer,
        outputId: bundle.decomposition, kind: trap.kind, templateId,
        intended, actual: variant.checks[id]?.final ?? null, baseline: base.checks[id]?.final ?? null,
      });
    }
  }
  const sorted = Object.fromEntries(Object.entries(outputs).sort(([a], [b]) => a.localeCompare(b)));
  const baseOutputs = inputs.map(input => outputs[input.file]!);
  const baseKeys = new Set(inputs.map(input => input.file));
  const quality = referenceQuality(baseOutputs, assessments, { outputIds: inputs.map(input => input.file),
    rejectedUnits: inputs.reduce((sum, input) => sum + (input.doc.rejected?.length ?? 0), 0),
    variantOutputs: Object.entries(sorted).filter(([key]) => !baseKeys.has(key)).map(([, output]) => output) });
  const artifact = { schema: 'paideia.references.v1', templatesDigest: stableDigest(templates), outputs: sorted, quality };
  await atomicWrite(options.out, { ...artifact, digest: stableDigest(artifact) });
  const reportFile = `${options.out}.md`;
  await atomicWrite(reportFile, referenceReport(artifact));
  return { file: options.out, reportFile, outputs: Object.keys(outputs).length, ...quality };
}
function referenceReport(artifact: { outputs: Record<string, CouncilOutput>; quality: ReturnType<typeof referenceQuality> }): string {
  const { quality } = artifact;
  const skipped = [...new Set(Object.values(artifact.outputs).flatMap(output => output.skipped.map(skip => `${skip.teacher}: ${skip.reason}`)))];
  const retained = Object.values(artifact.outputs).flatMap(output => output.calls);
  const calls = retained.filter(call => call.outcome !== 'cancelled');
  return [`# Council references: ${quality.gate}`, '',
    `Known-answer accuracy: ${quality.knownAnswer.accuracy === null ? 'unmeasured (no validated traps)' : `${(quality.knownAnswer.accuracy * 100).toFixed(2)}%`} (${quality.knownAnswer.correct}/${quality.knownAnswer.total}).`,
    `Consistency: ${quality.consistency.accuracy === null ? 'unmeasured' : `${(quality.consistency.accuracy * 100).toFixed(2)}%`} (${quality.consistency.correct}/${quality.consistency.total}).`,
    `Known-answer output coverage: ${quality.coverage.covered}/${quality.coverage.total}; uncovered: ${quality.coverage.uncovered.join(', ') || 'none'}.`,
    `Rejected units counted as missing checks: ${quality.coverage.missingChecks}.`,
    `Missing base checks: ${(quality.completeness.rate * 100).toFixed(2)}% (${quality.completeness.missing}/${quality.completeness.total}); required <= 0%.`,
    ...Object.entries(quality.completeness.byTemplate).map(([id, score]) => `- Missing base checks for template ${id}: ${score.missing}/${score.total}.`),
    ...Object.entries(quality.completeness.byOutput).map(([id, score]) => `- Missing base checks for output ${id}: ${score.missing}/${score.total}.`),
    `Base adjudication instability: ${(quality.instability.rate * 100).toFixed(2)}% (${quality.instability.unstable}/${quality.instability.items}).`,
    `Variant adjudication (diagnostic): ${(quality.variantAdjudication.rate * 100).toFixed(2)}% (${quality.variantAdjudication.unstable}/${quality.variantAdjudication.items}).`,
    `Calls: ${calls.length}; recorded latency: ${calls.reduce((sum, call) => sum + call.wallMs, 0).toFixed(0)} ms. Usage and subscription accounting are recorded per call; unreported usage/cost remains unknown.`, '',
    'Per-teacher accounting (all retained calls, including adjudication, failed/cancelled calls and earlier attempts; resume does not add reused calls):', '',
    ...[...new Set(Object.values(artifact.outputs).flatMap(output => [...(output.active_teachers ?? []), ...output.skipped.map(skip => skip.teacher)]))].map(id => {
      const own = retained.filter(call => call.teacher === id);
      const tokens = (key: 'inputTokens' | 'outputTokens') => {
        const known = own.filter(call => call.usage?.[key] != null);
        const sum = known.reduce((total, call) => total + call.usage![key]!, 0);
        return known.length === own.length ? String(sum) : `${sum} reported; ${own.length - known.length} calls unknown`;
      };
      return `- ${id}: ${own.length} calls; input tokens: ${tokens('inputTokens')}; output tokens: ${tokens('outputTokens')}; summed call wall time: ${own.reduce((sum, call) => sum + call.wallMs, 0).toFixed(0)} ms.`;
    }), '',
    ...retained.filter(call => call.failure_class).map(call =>
      `- Failed council call ${call.id} (${call.teacher}, ${call.phase}): ${call.failure_class}; ${call.check_ids.length} checks affected.`),
    ...quality.warnings.map(warning => `- WARNING: ${warning}`),
    ...quality.failures.map(failure => `- STOP: ${failure}`),
    ...quality.failingKinds.map(kind => `- Failing trap kind: ${kind}`),
    ...quality.failingTemplates.map(id => `- Failing template: ${id}`),
    ...skipped.map(skip => `- Skipped ${skip}`), '',
    ...quality.insufficientKinds.map(kind => `- Insufficient known-answer samples for kind: ${kind} (<10)`),
    ...quality.insufficientTemplates.map(id => `- Insufficient known-answer samples for template: ${id} (<10)`),
    'Known-answer accuracy by kind:', '', ...Object.entries(quality.byKind).map(([kind, score]) => `- ${kind}: ${score.correct}/${score.total}`), '',
    'DIAGNOSTIC accuracy by kind (excluded from gates and coverage):', '',
    ...Object.entries(quality.diagnosticByKind).map(([kind, score]) => `- ${kind}: ${score.correct}/${score.total} (${(score.accuracy! * 100).toFixed(2)}%)`), '',
    'DIAGNOSTIC accuracy by template:', '',
    ...Object.entries(quality.diagnosticByTemplate).map(([id, score]) => `- ${id}: ${score.correct}/${score.total}`), '',
    'Control CONSISTENCY by kind:', '', ...Object.entries(quality.consistencyByKind).map(([kind, score]) => `- ${kind}: ${score.correct}/${score.total}`), '',
    'Option-permutation consistency: ' + (quality.optionPermutation.accuracy === null ? 'unmeasured' : `${quality.optionPermutation.correct}/${quality.optionPermutation.total}`) + '.', '',
    'Teachers against references excluding themselves:', '',
    ...Object.entries(quality.teachers).map(([id, score]) => `- ${id}: ${(score.agreement * 100).toFixed(2)}% agreement on ${score.items} checks; soft agreement ${score.softAgreement.toFixed(4)}.`), '',
    'Agent agreement is not independent correctness. Known-answer traps measure constructed-control accuracy; external reviews and editor verdicts remain weak signals.', '',
  ].join('\n');
}
