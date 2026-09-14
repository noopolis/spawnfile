import type { TrainingConfiguration } from '../../contracts/training-config.js';
import { fail, fields, number, object, oneOf, safePath, string, uniqueStrings } from '../validation.js';

function integer(value: unknown, path: string, min = 1, max = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(number(value, path, min, max))) fail(path, 'expected an integer');
}

/** Validate controls without executing templates or contacting declared providers. */
export function validateTrainingConfiguration(value: unknown, path = '$.training'): TrainingConfiguration {
  const config = object(value, path);
  fields(config, ['models', 'judges', 'optimizer', 'budget', 'cache', 'recovery', 'test', 'validation_groups', 'seed'], path);
  const models = object(config.models, `${path}.models`);
  if (!Object.keys(models).length) fail(`${path}.models`, 'requires a named model');
  for (const [name, value] of Object.entries(models)) {
    const location = `${path}.models.${name}`;
    string(name, location);
    const model = object(value, location);
    fields(model, ['provider', 'model', 'endpoint', 'reasoning_effort'], location);
    oneOf(model.provider, ['claude-subscription', 'grok-subscription', 'ollama'], `${location}.provider`);
    string(model.model, `${location}.model`);
    if (model.reasoning_effort !== undefined) {
      if (model.provider !== 'grok-subscription') fail(`${location}.reasoning_effort`, 'only supported for grok-subscription');
      oneOf(model.reasoning_effort, ['low', 'medium', 'high', 'xhigh'], `${location}.reasoning_effort`);
    }
    if (model.endpoint !== undefined) {
      if (model.provider !== 'ollama') fail(`${location}.endpoint`, 'only supported for ollama');
      let url: URL;
      try { url = new URL(string(model.endpoint, `${location}.endpoint`)); }
      catch { return fail(`${location}.endpoint`, 'expected an HTTP endpoint'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        fail(`${location}.endpoint`, 'expected HTTP endpoint without credentials, query or fragment');
      }
    }
  }
  function route(value: unknown, location: string, judge = false): void {
    const policy = object(value, location);
    fields(policy, ['model', 'fallbacks', 'attempts', 'timeout_ms', ...(judge ? ['template', 'citation_repairs'] : [])], location);
    const primary = string(policy.model, `${location}.model`);
    const fallbacks = policy.fallbacks === undefined ? [] : uniqueStrings(policy.fallbacks, `${location}.fallbacks`);
    if (fallbacks.includes(primary)) fail(`${location}.fallbacks`, 'primary model cannot be its own fallback');
    for (const name of [primary, ...fallbacks]) if (!Object.hasOwn(models, name)) fail(location, `unknown model ${name}`);
    if (policy.attempts !== undefined) integer(policy.attempts, `${location}.attempts`, 1, Math.min(10, 1 + fallbacks.length));
    if (policy.timeout_ms !== undefined) integer(policy.timeout_ms, `${location}.timeout_ms`, 1, 3_600_000);
    if (policy.citation_repairs !== undefined) oneOf(policy.citation_repairs, [0, 1], `${location}.citation_repairs`);
    if (policy.template !== undefined) {
      const template = object(policy.template, `${location}.template`);
      fields(template, ['language', 'text'], `${location}.template`);
      oneOf(template.language, ['jinja'], `${location}.template.language`);
      string(template.text, `${location}.template.text`);
    }
  }
  if (config.judges !== undefined) {
    for (const [name, value] of Object.entries(object(config.judges, `${path}.judges`))) {
      string(name, `${path}.judges`);
      route(value, `${path}.judges.${name}`, true);
    }
  }
  if (config.optimizer !== undefined) route(config.optimizer, `${path}.optimizer`);
  if (config.budget !== undefined) {
    const budget = object(config.budget, `${path}.budget`);
    fields(budget, ['max_trials', 'max_proposals', 'timeout_ms'], `${path}.budget`);
    for (const [key, value] of Object.entries(budget)) {
      integer(value, `${path}.budget.${key}`, 1, key === 'timeout_ms' ? 3_600_000 : key === 'max_trials' ? 10_000 : 1000);
    }
  }
  if (config.cache !== undefined) {
    const cache = object(config.cache, `${path}.cache`);
    fields(cache, ['mode', 'max_entries', 'namespace', 'directory'], `${path}.cache`);
    oneOf(cache.mode, ['off', 'exact', 'persistent'], `${path}.cache.mode`);
    if (cache.mode === 'persistent') {
      const namespace = string(cache.namespace, `${path}.cache.namespace`);
      if (!namespace.trim()) fail(`${path}.cache.namespace`, 'namespace cannot be whitespace');
      if (namespace.length > 512) fail(`${path}.cache.namespace`, 'namespace exceeds 512 characters');
      if (cache.directory !== undefined) safePath(cache.directory, `${path}.cache.directory`);
    } else if (cache.namespace !== undefined || cache.directory !== undefined) fail(`${path}.cache`, 'namespace and directory require persistent mode');
    if (cache.max_entries !== undefined) integer(cache.max_entries, `${path}.cache.max_entries`, 1, 10_000);
  }
  if (config.recovery !== undefined) {
    const recovery = object(config.recovery, `${path}.recovery`);
    fields(recovery, ['max_attempts'], `${path}.recovery`);
    if (recovery.max_attempts !== undefined) integer(recovery.max_attempts, `${path}.recovery.max_attempts`, 0, 10);
  }
  if (config.test !== undefined) safePath(config.test, `${path}.test`);
  if (config.validation_groups !== undefined) uniqueStrings(config.validation_groups, `${path}.validation_groups`);
  if (config.seed !== undefined) integer(config.seed, `${path}.seed`, 0);
  return structuredClone(config) as unknown as TrainingConfiguration;
}
