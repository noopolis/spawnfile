import type { DataMap, DataValue, Dataset, DatasetRecord, ResolutionOptions } from '../contracts/dataset.js';
import { validateBindingReferences } from './turn-bindings.js';
import { canonical, fail, object } from './validation.js';

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function mergeFixtureValues(left: unknown, right: unknown, path = '$'): unknown {
  if (isMapping(left) && isMapping(right)) {
    const merged = structuredClone(left);
    for (const [key, value] of Object.entries(right)) {
      merged[key] = Object.hasOwn(left, key) ? mergeFixtureValues(left[key], value, `${path}.${key}`) : structuredClone(value);
    }
    return merged;
  }
  if (canonical(left) !== canonical(right)) fail(path, 'conflicting selected fixtures');
  return structuredClone(left);
}
export function overlayValues(base: unknown, local: unknown): unknown {
  if (isMapping(base) && isMapping(local)) {
    const result = structuredClone(base);
    for (const [key, value] of Object.entries(local)) result[key] = overlayValues(base[key], value);
    return result;
  }
  return structuredClone(local);
}
export function resolveContext(value: DataValue, context: DataMap, path: string, depth = 0): DataValue {
  if (depth > 64) return fail(path, 'context binding cycle or excessive nesting');
  if (Array.isArray(value)) return value.map((item, index) => resolveContext(item, context, `${path}[${index}]`, depth + 1));
  if (!isMapping(value)) return value;
  if (Object.hasOwn(value, 'context')) {
    if (Object.keys(value).length !== 1 || typeof value.context !== 'string') return fail(path, 'invalid context binding');
    let resolved: DataValue = context;
    for (const key of value.context.split('.')) {
      if (!isMapping(resolved) || !Object.hasOwn(resolved, key)) return fail(path, `missing context ${value.context}`);
      resolved = resolved[key] as DataValue;
    }
    return resolveContext(resolved, context, path, depth + 1);
  }
  const result: DataMap = {};
  for (const [key, item] of Object.entries(value)) result[key] = resolveContext(item as DataValue, context, `${path}.${key}`, depth + 1);
  return result;
}
function changedPaths(base: unknown, local: unknown, prefix = ''): string[] {
  if (isMapping(local) && !isMapping(base) && !Object.keys(local).length) return [prefix];
  if (isMapping(local)) return Object.entries(local).flatMap(([key, value]) =>
    changedPaths(isMapping(base) ? base[key] : undefined, value, prefix ? `${prefix}.${key}` : key));
  return canonical(base) === canonical(local) ? [] : [prefix];
}
function allowed(path: string, paths: readonly string[]): boolean {
  return paths.some(prefix => path === prefix || path.startsWith(`${prefix}.`));
}
export function expandRecord(dataset: Dataset, record: DatasetRecord, options: ResolutionOptions): DatasetRecord {
  let merged: unknown = {};
  for (const name of record.use ?? []) {
    const fixture = dataset.fixtures?.[name];
    if (!fixture) fail(`record.${record.id}.use`, `unknown fixture ${name}`);
    merged = mergeFixtureValues(merged, fixture, `record.${record.id}`);
  }
  const expanded = overlayValues(merged, record) as DatasetRecord;
  const rootSetup = dataset.setup ?? {};
  const localSetup = expanded.setup ?? {};
  const changes = changedPaths(rootSetup, localSetup);
  if (changes.length) {
    const profile = rootSetup.profile;
    if (typeof profile !== 'string') fail(`record.${record.id}.setup`, 'record parameters require a dataset preparation profile');
    const preparation = options.registry?.preparations?.[profile];
    if (!preparation) fail(`record.${record.id}.setup`, `unsupported preparation ${profile}`);
    for (const path of changes) {
      if (path === 'profile' || !allowed(path, preparation.unlockedPaths) || !allowed(path, options.unlockedSetupPaths ?? [])) {
        fail(`record.${record.id}.setup.${path}`, 'locked preparation parameter');
      }
    }
  }
  const context = expanded.context ?? {};
  expanded.context = resolveFields(context, context, `record.${record.id}.context`, false);
  if (dataset.setup !== undefined || expanded.setup !== undefined) {
    const setup = overlayValues(rootSetup, localSetup) as DataMap;
    const { artifacts, ...parameters } = setup;
    expanded.setup = resolveFields(parameters, expanded.context, `record.${record.id}.setup`, false);
    if (artifacts !== undefined) {
      expanded.setup.artifacts = resolveFields(artifacts as DataMap, expanded.context, `record.${record.id}.setup.artifacts`, false);
    }
    const profile = expanded.setup.profile;
    if (typeof profile !== 'string') fail(`record.${record.id}.setup.profile`, 'required preparation profile');
    const preparation = options.registry?.preparations?.[profile];
    if (!preparation) fail(`record.${record.id}.setup`, `unsupported preparation ${profile}`);
    const { profile: _profile, ...resolvedParameters } = expanded.setup;
    preparation.validate(resolvedParameters, `record.${record.id}.setup`);
  }
  if (expanded.input) {
    expanded.input = resolveFields(expanded.input as unknown as DataMap, expanded.context, `record.${record.id}.input`, false);
  }
  for (const turn of expanded.turns ?? []) {
    turn.input = resolveFields(turn.input as unknown as DataMap, expanded.context, `record.${record.id}.turn.${turn.id}.input`, true);
  }
  if (expanded.reference) {
    expanded.reference = resolveFields(expanded.reference as unknown as DataMap, expanded.context, `record.${record.id}.reference`, false);
  }
  if (expanded.outputs && expanded.setup?.artifacts) {
    const collectors = object(expanded.setup.artifacts, `record.${record.id}.setup.artifacts`);
    for (const name of Object.keys(expanded.outputs)) if (Object.hasOwn(collectors, name)) fail(`record.${record.id}.outputs.${name}`, 'conflicts with trusted preparation artifact');
  }
  return expanded;
}

/** Containers name fields; only their values may carry the reserved binding forms. */
function resolveFields(values: DataMap, context: DataMap, path: string, allowDeferred: boolean): DataMap {
  const result: DataMap = {};
  for (const [key, value] of Object.entries(values)) {
    const location = `${path}.${key}`;
    if (!allowDeferred) validateBindingReferences(value, new Set(), location);
    result[key] = resolveContext(value, context, location);
    if (!allowDeferred) validateBindingReferences(result[key], new Set(), location);
  }
  return result;
}
