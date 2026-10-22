import { projectDatasetCost, type CostDataset } from './cost-projection.js';
import { createHash } from 'node:crypto';
import type { DatasetDocument, ResolutionOptions, ResolvedDataset, ResolvedRecord } from '../contracts/dataset.js';
import { expandRecord } from './fixtures.js';
import { normalizeStages, resolveLive, resolveStages } from './plans.js';
import { validateBindingReferences } from './turn-bindings.js';
import { validateReferenceIsolation } from './splits.js';
import { validateDataset, validateRecord } from './schema.js';
import { canonical, fail, object } from './validation.js';
import { trainingJudgeVersions } from './training/index.js';

export function resolveDataset(document: DatasetDocument, options: ResolutionOptions = {}): ResolvedDataset {
  return resolve(document, options, false);
}

/** Cost-only structural resolution never calls preparation plugins or returns executable records. */
export function resolveDatasetForCost(document: DatasetDocument, options: ResolutionOptions = {}): CostDataset {
  return projectDatasetCost(resolve(document, options, true));
}

function resolve(document: DatasetDocument, options: ResolutionOptions, costOnly: boolean): ResolvedDataset {
  const dataset = validateDataset(document.dataset);
  if (options.subject !== undefined && dataset.subject !== undefined && options.subject !== dataset.subject) {
    fail('$.subject', 'does not match the selected native subject');
  }
  const registry = { ...options.registry, judges: { ...options.registry?.judges } };
  for (const [name, authored] of Object.entries(dataset.training ? trainingJudgeVersions(dataset.training, options.inferenceExecutionIdentity) : {})) {
    const installed = registry.judges[name];
    if (installed && installed.version !== authored.version) registry.judges[name] = { version: `${installed.version}|${authored.version}` };
  }
  const versions: Record<string, string> = {};
  const criterionFileDigests: Record<string, string> = {};
  const context = { registry, versions, sourceName: document.sourceName, criterionFileDigests, criterionFiles: new Map<string, Uint8Array>(),
    readCriterionFile: options.readCriterionFile ? (path: string) => options.readCriterionFile!(path, document.sourceName) : undefined };
  const sharedStages = resolveStages(normalizeStages(dataset), context);
  const live = { checks: resolveLive(dataset.live?.checks ?? [], context) };
  if (dataset.setup !== undefined) {
    const profile = dataset.setup.profile;
    if (typeof profile !== 'string' || !profile) fail('$.setup.profile', 'required preparation profile');
    const preparation = registry.preparations?.[profile];
    if (!costOnly) {
      if (!preparation) fail('$.setup', `unsupported preparation ${profile}`);
      versions[`preparation:${profile}`] = preparation.version;
    }
  }
  const sharedVersions = structuredClone(versions);
  const records: ResolvedRecord[] = dataset.records.map(record => {
    if (options.requireGroups && !record.group) fail(`record.${record.id}.group`, 'required for optimization and held-out comparison');
    const expanded = expandRecord(dataset, record, options, costOnly);
    validateRecord(expanded, `record.${record.id}`, true);
    if (expanded.setup && !costOnly) {
      const profile = expanded.setup.profile as string;
      versions[`preparation:${profile}`] = registry.preparations![profile]!.version;
    }
    const artifactNames = new Set(Object.keys(expanded.outputs ?? {}));
    if (expanded.setup?.artifacts) {
      for (const name of Object.keys(object(expanded.setup.artifacts, 'setup.artifacts'))) artifactNames.add(name);
    }
    const recordContext = { ...context, artifacts: artifactNames };
    const stages = [...normalizeStages(dataset), ...normalizeStages(expanded, 'record-checks')];
    if (!stages.length) fail(`record.${record.id}`, 'requires at least one effective terminal check');
    const effectiveStages = resolveStages(stages, recordContext);
    const recordLive = { checks: resolveLive(dataset.live?.checks ?? [], recordContext) };
    const availableBindings = new Set<string>();
    for (const turn of expanded.turns ?? []) {
      if (turn.checks) turn.checks = resolveStages(normalizeStages({ checks: turn.checks }, `turn-${turn.id}`), recordContext, true)[0]!.checks;
      validateBindingReferences(turn.input, availableBindings, `record.${record.id}.turn.${turn.id}.input`);
      for (const name of Object.keys(turn.bind ?? {})) {
        if (availableBindings.has(name)) fail(`record.${record.id}`, `duplicate trusted binding ${name}`);
        availableBindings.add(name);
      }
    }
    if (expanded.input) validateBindingReferences(expanded.input, new Set(), `record.${record.id}.input`);
    const { use, checks: _checks, stages: _stages, ...fields } = expanded;
    return { ...fields, fixtureProvenance: use ?? [], effectiveStages, live: recordLive };
  });
  validateReferenceIsolation(records);
  return {
    schema: dataset.schema, id: dataset.id, ...(dataset.subject ? { subject: dataset.subject } : {}), records,
    ...(dataset.training ? { training: structuredClone(dataset.training) } : {}),
    sharedStages, live, sharedPlanDigest: `sha256:${createHash('sha256').update(canonical({ stages: sharedStages, live, versions: sharedVersions, ...(costOnly ? { preparationProfile: dataset.setup?.profile ?? null } : {}) })).digest('hex')}`,
    sourceDigest: document.sourceDigest, sourceName: document.sourceName, registryVersions: versions, criterionFileDigests,
  };
}
