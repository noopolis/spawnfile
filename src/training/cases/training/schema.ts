import type { TrainingConfiguration } from '../../contracts/training-config.js';
import { fail, fields, number, object, oneOf, safePath, string, uniqueStrings } from '../validation.js';

function integer(value: unknown, path: string, min = 1, max = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(number(value, path, min, max))) fail(path, 'expected an integer');
}

/** Validate controls without executing templates or contacting declared providers. */
export function validateTrainingConfiguration(value: unknown, path = '$.training'): TrainingConfiguration {
  const config = object(value, path);
  fields(config, ['models', 'judges', 'optimizer', 'comparison', 'budget', 'cache', 'recovery', 'test', 'validation_groups', 'seed'], path);
  const models = object(config.models, `${path}.models`);
  if (!Object.keys(models).length) fail(`${path}.models`, 'requires a named model');
  for (const [name, value] of Object.entries(models)) {
    const location = `${path}.models.${name}`;
    string(name, location);
    const model = object(value, location);
    fields(model, ['provider', 'model', 'endpoint', 'reasoning_effort', 'think', 'keep_alive_seconds', 'max_output_tokens', 'context_window'], location);
    oneOf(model.provider, ['claude-subscription', 'grok-subscription', 'ollama'], `${location}.provider`);
    string(model.model, `${location}.model`);
    if (model.reasoning_effort !== undefined) {
      if (model.provider !== 'grok-subscription') fail(`${location}.reasoning_effort`, 'only supported for grok-subscription');
      oneOf(model.reasoning_effort, ['low', 'medium', 'high', 'xhigh'], `${location}.reasoning_effort`);
    }
    for (const field of ['think', 'keep_alive_seconds', 'max_output_tokens', 'context_window']) {
      if (model[field] !== undefined && model.provider !== 'ollama') fail(`${location}.${field}`, 'only supported for ollama');
    }
    if (model.think !== undefined && typeof model.think !== 'boolean') fail(`${location}.think`, 'expected a boolean');
    if (model.keep_alive_seconds !== undefined) integer(model.keep_alive_seconds, `${location}.keep_alive_seconds`, 0, 86400);
    if (model.context_window !== undefined) integer(model.context_window, `${location}.context_window`, 512, 1048576);
    if (model.max_output_tokens !== undefined) integer(model.max_output_tokens, `${location}.max_output_tokens`, 1, 131072);
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
    fields(policy, ['model', 'fallbacks', 'attempts', 'timeout_ms', ...(judge ? ['template', 'citation_repairs', 'protocol'] : ['proposal'])], location);
    const primary = string(policy.model, `${location}.model`);
    const fallbacks = policy.fallbacks === undefined ? [] : uniqueStrings(policy.fallbacks, `${location}.fallbacks`);
    if (fallbacks.includes(primary)) fail(`${location}.fallbacks`, 'primary model cannot be its own fallback');
    for (const name of [primary, ...fallbacks]) if (!Object.hasOwn(models, name)) fail(location, `unknown model ${name}`);
    if (policy.attempts !== undefined) integer(policy.attempts, `${location}.attempts`, 1, Math.min(10, 1 + fallbacks.length));
    if (policy.timeout_ms !== undefined) integer(policy.timeout_ms, `${location}.timeout_ms`, 1, 3_600_000);
    if (policy.citation_repairs !== undefined) oneOf(policy.citation_repairs, [0, 1], `${location}.citation_repairs`);
    if (policy.protocol !== undefined) oneOf(policy.protocol, ['citations', 'evidence-ids'], `${location}.protocol`);
    if (policy.protocol === 'evidence-ids' && policy.citation_repairs === 1) fail(`${location}.citation_repairs`, 'citation repair is not supported for evidence-ids');
    if (policy.proposal !== undefined) {
      const proposal = object(policy.proposal, `${location}.proposal`);
      fields(proposal, ['strategy', 'min_change', 'max_attempts', 'history_entries', 'history_bytes'], `${location}.proposal`);
      if (proposal.strategy !== undefined) oneOf(proposal.strategy, ['refine', 'rewrite'], `${location}.proposal.strategy`);
      if (proposal.min_change !== undefined) number(proposal.min_change, `${location}.proposal.min_change`, 0, 1);
      for (const [field, min, max] of [['max_attempts', 1, 5], ['history_entries', 1, 100], ['history_bytes', 1024, 262144]] as const) {
        if (proposal[field] !== undefined) integer(proposal[field], `${location}.proposal.${field}`, min, max);
      }
    }
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
  if (config.comparison !== undefined) {
    const comparison = object(config.comparison, `${path}.comparison`);
    fields(comparison, ['candidate'], `${path}.comparison`);
    const candidate = object(comparison.candidate, `${path}.comparison.candidate`);
    fields(candidate, ['name', 'replacements'], `${path}.comparison.candidate`);
    const name = string(candidate.name, `${path}.comparison.candidate.name`);
    if (!name.trim() || name.length > 120) fail(`${path}.comparison.candidate.name`, 'expected 1..120 characters');
    if (!Array.isArray(candidate.replacements) || !candidate.replacements.length || candidate.replacements.length > 128) {
      fail(`${path}.comparison.candidate.replacements`, 'requires 1..128 resource replacements');
    }
    const resources = new Set<string>();
    for (const [index, value] of (candidate.replacements as unknown[]).entries()) {
      const location = `${path}.comparison.candidate.replacements[${index}]`;
      const row = object(value, location);
      fields(row, ['resource', 'source'], location);
      const resource = safePath(row.resource, `${location}.resource`);
      safePath(row.source, `${location}.source`);
      if (resources.has(resource)) fail(location, 'duplicate comparison resource');
      resources.add(resource);
    }
    if (config.optimizer !== undefined) fail(`${path}.optimizer`, 'comparison does not run an optimizer');
    if (config.budget !== undefined && Object.hasOwn(object(config.budget, `${path}.budget`), 'max_proposals')) {
      fail(`${path}.budget.max_proposals`, 'comparison has no proposals; omit this field');
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
