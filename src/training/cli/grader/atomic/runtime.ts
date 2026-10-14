import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { JudgeCall } from '../../../contracts/evaluation.js';
import type { AtomicRuntime, AtomicExtraction } from '../../../graders/atomic/index.js';
import { parseAtomicGraderYaml, validateAtomicTemplates } from '../../../graders/atomic/index.js';
import { parseCheckTemplatesYaml } from '../../../graders/decomposition/index.js';
import { sha256, stableDigest } from '../../../graders/index.js';
import { assertModelRequestAdmission, budgetEvaluatorInference } from '../../../inference/index.js';
import { createTypeSafeDecision } from '../../../inference/decision/index.js';
import type { GraderDependencies } from '../backend.js';
import { createGraderTeacher } from '../label-call.js';
import { runDecompose, type ExtractionReceipt } from './decompose.js';
import { atomicWrite, readOptional } from './files.js';

const resources = new Map<string, object>();
function resource(key: string): object {
  if (!resources.has(key)) resources.set(key, {});
  return resources.get(key)!;
}

export async function buildAtomicRuntime(file: string, dependencies: GraderDependencies = {}): Promise<AtomicRuntime> {
  const source = await readFile(file, 'utf8'), grader = parseAtomicGraderYaml(source);
  const templateSource = await readFile(resolve(dirname(file), grader.templates), 'utf8');
  const templates = parseCheckTemplatesYaml(templateSource);
  validateAtomicTemplates(grader, templates);
  assertModelRequestAdmission(grader.extractor.provider === 'codex' ? 'codex-subscription' : grader.extractor.provider, 'atomic extraction',
    { purpose: 'extraction', model: grader.extractor.model });
  assertModelRequestAdmission('typesafe', 'atomic decisions', { purpose: 'decisions', model: grader.decision.model });
  const maxSpendUsd = Math.min(grader.decision.max_spend_usd, dependencies.maxSpendUsd ?? Infinity);
  // Construct before extraction: a missing key must never consume a subscription call.
  const backend = createTypeSafeDecision({ model: grader.decision.model, maxSpendUsd,
    pricePerMtokUsd: grader.decision.price_per_mtok_usd, maxAttempts: 1, concurrency: 1,
    conservativeSpend: true, fetch: dependencies.atomicFetch });
  // Snapshot all authoring bytes into memory; subjects cannot change this runtime's policy.
  const { deadline_ms: _deadline, ...teacher } = grader.extractor;
  const frozen = { ...templates, teachers: [teacher] };
  return { kind: 'atomic', grader, templates, backend, definitionDigest: sha256(source), templatesDigest: sha256(templateSource),
    resource: resource('typesafe'), resources: [resource('typesafe'), resource(`extractor:${grader.extractor.model}`)],
    async extract(inputs, signal) {
      const directory = await mkdtemp(join(tmpdir(), 'paideia-atomic-trial-'));
      const out = join(directory, 'decomposition');
      const receipts: AtomicExtraction['receipts'] = [];
      const judgeCalls: JudgeCall[] = [];
      let error: string | undefined;
      try {
        await atomicWrite(join(directory, 'templates.json'), frozen);
        await atomicWrite(join(directory, 'output.json'), JSON.stringify(inputs.output));
        const context = Object.fromEntries(Object.entries(inputs.context).map(([name]) => [name, { from: `${sha256(name)}.json` }]));
        for (const [name, value] of Object.entries(inputs.context)) await atomicWrite(join(directory, `${sha256(name)}.json`), JSON.stringify(value));
        await atomicWrite(join(directory, 'inputs.json'), { schema: 'paideia.grader-inputs.v1', items: [{
          id: 'trial', lineage: 'trial', output: { from: 'output.json' }, context,
        }] });
        const deadline = AbortSignal.timeout(grader.extractor.deadline_ms);
        await runDecompose({ templatesFile: join(directory, 'templates.json'), inputsFile: join(directory, 'inputs.json'),
          obligationKinds: grader.aggregation.obligation_kinds,
          out, extractors: [grader.extractor.id], signal: signal ? AbortSignal.any([signal, deadline]) : deadline },
        { provider: teacher => budgetEvaluatorInference(
          (dependencies.provider ?? (definition => createGraderTeacher(definition, grader.extractor.deadline_ms)))(teacher),
          teacher.provider === 'codex' ? 'codex-subscription' : teacher.provider, 'extraction', teacher.model) });
      } catch { error = 'Atomic extraction or omission audit failed'; }
      try {
        const checkpoint = await readOptional<{ receipts: ExtractionReceipt[]; decomposition?: AtomicExtraction['decomposition'];
          rejected: unknown[]; dropped: unknown[]; citationDisagreements: unknown[]; duplicates: unknown[] }>(join(out, `${stableDigest('trial')}.checkpoint.json`));
        if (checkpoint) {
          receipts.push(JSON.parse(JSON.stringify(checkpoint)) as Record<string, unknown>);
          for (const receipt of checkpoint.receipts) {
            if (receipt.attempts?.length) {
              for (const attempt of receipt.attempts) judgeCalls.push({ id: attempt.id, judge: receipt.teacher,
                providerId: attempt.providerId, requestedModel: attempt.requestedModel, responseModel: attempt.responseModel,
                responseRoute: attempt.responseRoute, outcome: attempt.outcome === 'failed' ? 'generation-error'
                  : receipt.outcome === 'invalid-response' ? 'invalid-response' : 'completed',
                ...(attempt.failureKind ? { failureKind: attempt.failureKind } : {}), usage: attempt.usage, billing: 'subscription' });
            } else judgeCalls.push({ id: randomUUID(), judge: receipt.teacher,
              providerId: receipt.provider, requestedModel: receipt.model, responseModel: receipt.reported_model,
              responseRoute: receipt.route, outcome: receipt.outcome === 'completed' ? 'completed' : receipt.outcome === 'invalid-response' ? 'invalid-response' : 'generation-error',
              usage: receipt.usage, wallMs: receipt.wall_ms, billing: 'subscription' });
          }
        }
        return { decomposition: checkpoint?.decomposition, receipts, judgeCalls, ...(error ? { error } : {}) };
      } finally { await rm(directory, { recursive: true, force: true }); }
    } };
}
