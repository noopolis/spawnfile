import { beforeEach, expect, it, vi } from 'vitest';
import type { GraderProviderRegistry, InferenceProvider } from './index.js';

beforeEach(() => vi.resetModules());
function fixture(): GraderProviderRegistry {
  return { providers: [{ id: 'fixture', inferenceProviderId: 'fixture-inference', decisionTools: 'disabled', teacherPolicy: 'fixture.v1',
    decompositionExtractor: true, atomicExtractor: true, validateAtomicConfig: () => undefined,
    create() {
      let calls = 0;
      return { id: 'fixture', capabilities: { tools: 'disabled', billing: 'subscription', seed: false, temperature: false },
        generate: async () => ({ text: String(++calls), model: 'fixture', route: 'fixture', usage: null }) };
    } }], council: { requiredProviders: ['fixture'], requiredMessage: 'Requires fixture',
    defaultWindow: { start: '00:00', end: '23:59' }, windowOpen: () => true, limitedProvider: 'fixture',
    outsideWindow: () => 'Outside fixture window', closedWindow: () => 'Closed fixture window', extractorMessage: 'Choose fixture' } };
}
it('requires explicit composition and rejects unknown providers', async () => {
  const core = await import('./grader-providers.js');
  expect(() => core.graderProviderRegistry()).toThrow('not configured');
  const registry = fixture(); core.configureGraderProviders(registry);
  expect(core.graderProvider('fixture')).toBe(registry.providers[0]);
  expect(() => core.graderProvider('unknown')).toThrow('Unsupported');
});
it('permits idempotent installation and refuses replacement or descriptor mutation', async () => {
  const core = await import('./grader-providers.js'), registry = fixture();
  core.configureGraderProviders(registry); core.configureGraderProviders(registry);
  expect(() => core.configureGraderProviders(fixture())).toThrow('already configured');
  expect(() => { registry.providers[0]!.teacherPolicy = 'changed'; }).toThrow();
  expect(core.graderProvider('fixture').teacherPolicy).toBe('fixture.v1');
});
it('rejects duplicate registrations', async () => {
  const core = await import('./grader-providers.js'), registry = fixture();
  expect(() => core.configureGraderProviders({ ...registry, providers: [...registry.providers, ...registry.providers] })).toThrow('Duplicate');
});
it('constructs independent providers for each caller', async () => {
  const core = await import('./grader-providers.js'); core.configureGraderProviders(fixture());
  const teacher = { id: 't', provider: 'fixture', model: 'm' };
  const first: InferenceProvider = core.graderProvider('fixture').create(teacher);
  const second = core.graderProvider('fixture').create(teacher);
  const request = { model: 'm', prompt: 'test' };
  expect((await first.generate(request)).text).toBe('1');
  expect((await first.generate(request)).text).toBe('2');
  expect((await second.generate(request)).text).toBe('1');
  expect(first).not.toBe(second);
});
