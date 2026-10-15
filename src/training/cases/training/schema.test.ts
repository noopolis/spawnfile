import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { parseDatasetYaml, resolveDataset } from '../index.js';
import { trainingJudgeVersions, validateTrainingConfiguration } from './index.js';

const config = {
  models: { cheap: { provider: 'grok-subscription', model: 'grok-fast' },
    local: { provider: 'ollama', model: 'local-model', endpoint: 'http://localhost:11434' } },
  judges: { prose: { model: 'cheap', fallbacks: ['local'], attempts: 2, timeout_ms: 1000,
    citation_repairs: 1, template: { language: 'jinja', text: 'Check {{ rubric }}.' } } },
  optimizer: { model: 'cheap' }, budget: { max_trials: 12, max_proposals: 3, timeout_ms: 10000 },
  cache: { mode: 'exact', max_entries: 100 }, test: 'test.paideia.yaml', validation_groups: ['validation'], seed: 0,
};
const dataset = (training?: unknown) => ({ schema: 'paideia.dataset.v1', id: 'example',
  ...(training ? { training } : {}), checks: [{ id: 'prose', eval: 'llm-rubric', input: 'output.text',
    judge: 'prose', rubric: { prompt: 'No repetition.' }, minimum: 0.8 }],
  records: [{ id: 'one', input: { prompt: 'Write.' } }] });

describe('dataset-authored training configuration', () => {
  it('accepts Codex subscription models for YAML judges and optimizer routes', () => {
    const training = { models: { codex: { provider: 'codex-subscription', model: 'chosen' } },
      judges: { prose: { model: 'codex' } }, optimizer: { model: 'codex' } };
    const parsed = parseDatasetYaml(stringify(dataset(training)));
    expect(parsed.dataset.training).toEqual(training);
    expect(resolveDataset(parsed, { registry: { judges: trainingJudgeVersions(parsed.dataset.training!) } }).training)
      .toEqual(training);
  });
  it.each<[string, unknown, RegExp]>([
    ['api_key', 'forbidden-test-value', /unknown field/],
    ['endpoint', 'http://localhost:11434', /only supported for ollama/],
    ['reasoning_effort', 'low', /only supported for grok-subscription or grok-broker/],
    ...['think', 'keep_alive_seconds', 'max_output_tokens', 'context_window'].map<[string, unknown, RegExp]>(field =>
      [field, 1, /only supported for ollama/]),
  ])('rejects unsupported Codex training control %s', (field, value, reason) => {
    expect(() => validateTrainingConfiguration({ models: { codex: {
      provider: 'codex-subscription', model: 'chosen', [field]: value,
    } } })).toThrow(reason);
  });
  it('preserves a standalone YAML configuration without sharing mutable objects', () => {
    const parsed = parseDatasetYaml(stringify(dataset(config)));
    const resolved = resolveDataset(parsed, { registry: { judges: trainingJudgeVersions(parsed.dataset.training!) } });
    expect(resolved.training).toEqual(config);
    resolved.training!.models.cheap!.model = 'changed';
    expect(parsed.dataset.training!.models.cheap!.model).toBe('grok-fast');
    expect(validateTrainingConfiguration({ models: { x: { provider: 'claude-subscription', model: 'haiku' } },
      judges: { plain: { model: 'x', citation_repairs: 0 } }, cache: { mode: 'off' } })).toBeDefined();
  });
  it.each([undefined, 'image:one'])('does not append an authored identity already registered in execution %s', inferenceExecutionIdentity => {
    const registry = { judges: trainingJudgeVersions(validateTrainingConfiguration(config), inferenceExecutionIdentity) };
    const configured = resolveDataset(parseDatasetYaml(stringify(dataset(config))), { registry, inferenceExecutionIdentity });
    const inherited = resolveDataset(parseDatasetYaml(stringify(dataset())), { registry, inferenceExecutionIdentity });
    expect(configured.sharedPlanDigest).toBe(inherited.sharedPlanDigest);
    expect(configured.registryVersions).toEqual(inherited.registryVersions);
  });
  it('does not claim a declared judge is an installed evaluator', () => {
    expect(() => resolveDataset(parseDatasetYaml(stringify(dataset(config))))).toThrow(/judge/);
  });
  it('tracks model, prompt and route policy changes but excludes optimization controls', () => {
    const initial = validateTrainingConfiguration(config);
    const identity = trainingJudgeVersions(initial);
    for (const mutate of [
      (value: typeof initial) => { value.models.cheap!.model = 'different'; },
      (value: typeof initial) => { value.models.cheap!.reasoning_effort = 'low'; },
      (value: typeof initial) => { value.judges!.prose!.template!.text = 'Different {{ rubric }}'; },
      (value: typeof initial) => { value.judges!.prose!.attempts = 1; },
      (value: typeof initial) => { value.models.local!.endpoint = 'http://another:11434'; },
    ]) {
      const changed = structuredClone(initial);
      mutate(changed);
      expect(trainingJudgeVersions(changed)).not.toEqual(identity);
    }
    const budgetOnly = validateTrainingConfiguration(config);
    budgetOnly.budget!.max_trials = 99;
    expect(trainingJudgeVersions(budgetOnly)).toEqual(identity);
    expect(trainingJudgeVersions({ models: initial.models })).toEqual({});
    expect(trainingJudgeVersions({ models: initial.models, judges: { simple: { model: 'cheap' } } }).simple!.version)
      .toMatch(/^paideia.authored-judge.v1:sha256:/);
    initial.models.cheap!.model = 'changed';
    const resolve = (training: unknown) => resolveDataset(parseDatasetYaml(stringify(dataset(training))), {
      registry: { judges: trainingJudgeVersions(validateTrainingConfiguration(training)) },
    });
    expect(resolve(initial).sharedPlanDigest).not.toBe(resolve(config).sharedPlanDigest);
    const fixedRegistry = { judges: { prose: { version: 'runtime-v1' } } };
    const fixedResolve = (training: unknown) => resolveDataset(parseDatasetYaml(stringify(dataset(training))), {
      registry: fixedRegistry,
    });
    expect(fixedResolve(initial).sharedPlanDigest).not.toBe(fixedResolve(config).sharedPlanDigest);
    expect(fixedRegistry.judges.prose.version).toBe('runtime-v1');
  });
  it('accepts broker-grant Grok models with a declared closed model and effort and non-desktop fallbacks', () => {
    const training = { models: { broker: { provider: 'grok-broker', model: 'grok-4.6', reasoning_effort: 'low' },
      reflect: { provider: 'grok-broker', model: 'grok-build', reasoning_effort: 'high' }, backup: { provider: 'claude-subscription', model: 'claude' } },
      judges: { prose: { model: 'broker', fallbacks: ['reflect', 'backup'] } }, optimizer: { model: 'reflect', fallbacks: ['backup'] } };
    expect(validateTrainingConfiguration(training)).toEqual(training);
    const versions = trainingJudgeVersions(validateTrainingConfiguration(training));
    const changed = structuredClone(training); changed.models.broker.reasoning_effort = 'medium';
    expect(trainingJudgeVersions(validateTrainingConfiguration(changed))).not.toEqual(versions);
  });
  it.each([
    [{ broker: { provider: 'grok-broker', model: 'grok-4.6' } }, 'required for grok-broker'],
    [{ broker: { provider: 'grok-broker', model: 'grok-4.6', reasoning_effort: 'xhigh' } }, 'reasoning_effort'],
    [{ broker: { provider: 'grok-broker', model: 'grok-fast', reasoning_effort: 'low' } }, 'models.broker.model'],
    [{ broker: { provider: 'claude-subscription', model: 'claude', reasoning_effort: 'low' } }, 'only supported for grok-subscription or grok-broker'],
  ])('rejects broker-grant model %j for its own reason', (models, reason) => {
    expect(() => validateTrainingConfiguration({ models })).toThrow(reason);
  });
  it('rejects routes that mix broker grants with a desktop Grok subscription in either order', () => {
    const models = { broker: { provider: 'grok-broker', model: 'grok-4.6', reasoning_effort: 'low' }, desktop: { provider: 'grok-subscription', model: 'grok-4.6' } };
    for (const training of [{ models, judges: { j: { model: 'broker', fallbacks: ['desktop'] } } }, { models, optimizer: { model: 'desktop', fallbacks: ['broker'] } }]) {
      expect(() => validateTrainingConfiguration(training)).toThrow('cannot fall back to a desktop grok-subscription login');
    }
  });
  it.each([
    { unexpected: true }, { models: {} }, { models: { x: { provider: 'api', model: 'x' } } },
    { models: { x: { provider: 'ollama', model: '' } } },
    { models: { x: { provider: 'grok-subscription', model: 'x', reasoning_effort: 'unbounded' } } },
    { models: { x: { provider: 'ollama', model: 'x', reasoning_effort: 'low' } } },
    { models: { x: { provider: 'claude-subscription', model: 'x', reasoning_effort: 'low' } } },
    ...['ftp://host', 'http://user:password@host', 'http://host?secret=x', 'http://host#x', 'bad'].map(endpoint =>
      ({ models: { x: { provider: 'ollama', model: 'x', endpoint } } })),
    { models: { x: { provider: 'grok-subscription', model: 'x', endpoint: 'http://host' } } },
    { models: { x: { provider: 'grok-broker', model: 'grok-4.6' } } },
    { models: { x: { provider: 'grok-broker', model: 'grok-4.6', reasoning_effort: 'xhigh' } } },
    { models: { x: { provider: 'grok-broker', model: 'grok-fast', reasoning_effort: 'low' } } },
    { models: { x: { provider: 'grok-broker', model: 'grok-4.6', reasoning_effort: 'low', endpoint: 'http://host' } } },
    { models: { ...config.models, broker: { provider: 'grok-broker', model: 'grok-4.6', reasoning_effort: 'low' } }, judges: { x: { model: 'broker', fallbacks: ['cheap'] } } },
    { models: { ...config.models, broker: { provider: 'grok-broker', model: 'grok-4.6', reasoning_effort: 'low' } }, optimizer: { model: 'cheap', fallbacks: ['broker'] } },
    { judges: { x: { model: 'missing' } } }, { judges: { x: { model: 'cheap', fallbacks: ['cheap'] } } },
    { judges: { x: { model: 'cheap', fallbacks: ['local', 'local'] } } },
    { judges: { x: { model: 'cheap', attempts: 0 } } }, { judges: { x: { model: 'cheap', attempts: 1.5 } } },
    { judges: { x: { model: 'cheap', attempts: 11 } } },
    { judges: { x: { model: 'cheap', attempts: 2 } } }, { judges: { x: { model: 'cheap', timeout_ms: 0 } } },
    { judges: { x: { model: 'cheap', citation_repairs: 2 } } },
    { judges: { x: { model: 'cheap', template: { language: 'javascript', text: 'code' } } } },
    { optimizer: { model: 'cheap', template: {} } }, { budget: { max_trials: -1 } },
    { budget: { max_cost: 10 } }, { budget: { max_trials: 10001 } }, { budget: { max_proposals: 1001 } }, { cache: { mode: 'semantic' } }, { cache: { mode: 'exact', max_entries: 0 } },
    { cache: { mode: 'exact', max_entries: 10001 } },
    { test: '../secret.yaml' }, { validation_groups: ['a', 'a'] }, { seed: -1 },
  ])('rejects unsupported or ambiguous controls: %j', override => {
    expect(() => parseDatasetYaml(stringify(dataset({ ...config, ...override })))).toThrow();
  });
});

it('accepts a separate dataset-relative validation input and rejects ambiguous or escaping inputs', () => {
  const models = { local: { provider: 'ollama', model: 'local' } };
  expect(validateTrainingConfiguration({ models, validation: 'validation.paideia.yaml' }).validation).toBe('validation.paideia.yaml');
  for (const config of [{ validation: '../secret.yaml' }, { validation: 'validation.yaml', validation_groups: ['a'] }]) {
    expect(() => validateTrainingConfiguration({ models, ...config })).toThrow();
  }
});

it.each([0, -1, 9, 1.5, '3', null, true])('refuses authored test_repeats=%s', test_repeats => {
  expect(() => validateTrainingConfiguration({ ...config, budget: { test_repeats } })).toThrow('budget.test_repeats');
});

it.each([1, 3, 8])('accepts authored test_repeats=%s', test_repeats => {
  expect(validateTrainingConfiguration({ ...config, budget: { test_repeats } }).budget).toEqual({ test_repeats });
});

it('validates deferred scoring without adding defaults to existing configuration', () => {
  expect(validateTrainingConfiguration(config)).toEqual(config);
  for (const scoring of [{}, { deferred: 'zero' }, { deferred: 'stage-score' }]) {
    const authored = { ...config, scoring };
    expect(parseDatasetYaml(stringify(dataset(authored))).dataset.training).toEqual(authored);
  }
  for (const scoring of [null, 'stage-score', [], { deferred: null }, { deferred: true },
    { deferred: 1 }, { deferred: 'pass' }, { deferred: 'stage-score', unknown: true }]) {
    expect(() => validateTrainingConfiguration({ ...config, scoring })).toThrow('scoring');
  }
});

it.each([-1, 4, 1.5, '1', null, true])('refuses authored trial_retries=%s', trial_retries => {
  expect(() => validateTrainingConfiguration({ ...config, budget: { trial_retries } })).toThrow('budget.trial_retries');
});
it.each([0, 1, 3])('accepts authored trial_retries=%s', trial_retries => {
  expect(validateTrainingConfiguration({ ...config, budget: { trial_retries } }).budget).toEqual({ trial_retries });
});
