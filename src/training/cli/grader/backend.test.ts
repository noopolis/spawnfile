import { beforeEach, expect, it, vi } from 'vitest';
import type { DecisionBackend } from '../../contracts/grading.js';
import type { InferenceProvider } from '../../contracts/execution.js';
import { parseGrader, stableDigest } from '../../graders/index.js';
import { createOllamaDecision, createJevDecision, createTeacherDecision } from '../../inference/decision/index.js';
import { createGraderTeacher } from './label.js';
import { backendIdentity, graderBackend } from './backend.js';

vi.mock('../../inference/decision/index.js', () => ({ createOllamaDecision: vi.fn(), createJevDecision: vi.fn(), createTeacherDecision: vi.fn() }));
vi.mock('./label.js', () => ({ createGraderTeacher: vi.fn() }));
const backend: DecisionBackend = { identity: async () => ({ backend: 'fake', model: 'm' }), score: async () => [] };
const provider: InferenceProvider = { id: 'test', capabilities: { billing: 'subscription', tools: 'disabled', temperature: false, seed: false },
  generate: async () => ({ model: 'm', text: 'yes', usage: null, route: 'fake' }) };
function grader(model: unknown) {
  return parseGrader({ schema: 'paideia.grader.v1', id: 'g', golden: 'labels.yaml', calibration: 'calibration.json',
    teachers: [{ id: 'c', provider: 'claude', model: 'opus' }], model, escalate: { to: 'c', between: [0.3, 0.7] },
    questions: [{ id: 'q', type: 'yes-no', expected: 'yes', reads: ['output.body'] }], score: { method: 'weighted' } });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createOllamaDecision).mockReturnValue(backend);
  vi.mocked(createJevDecision).mockReturnValue(backend);
  vi.mocked(createTeacherDecision).mockReturnValue(backend);
  vi.mocked(createGraderTeacher).mockReturnValue(provider);
});
it('constructs only the declared Ollama or Jev route', () => {
  expect(graderBackend(grader({ backend: 'ollama-logprobs', endpoint: 'http://localhost:11434', name: 'local' }))).toBe(backend);
  expect(createOllamaDecision).toHaveBeenCalledExactlyOnceWith({ endpoint: 'http://localhost:11434', model: 'local', contextTokens: 16384 });
  expect(graderBackend(grader({ backend: 'jev-http', endpoint: 'http://localhost/jev', name: 'ignored-until-reported' }))).toBe(backend);
  expect(createJevDecision).toHaveBeenCalledExactlyOnceWith({ endpoint: 'http://localhost/jev' });
  expect(createGraderTeacher).not.toHaveBeenCalled();
});
it('uses the named teacher and injected provider/backend without fallback', () => {
  const definition = grader({ backend: 'teacher', teacher: 'c' });
  expect(graderBackend(definition)).toBe(backend);
  expect(createGraderTeacher).toHaveBeenCalledExactlyOnceWith(definition.teachers[0]);
  expect(createTeacherDecision).toHaveBeenCalledWith({ provider, model: 'opus' });
  const injectedProvider = vi.fn(() => provider);
  expect(graderBackend(definition, { provider: injectedProvider })).toBe(backend);
  expect(injectedProvider).toHaveBeenCalledExactlyOnceWith(definition.teachers[0]);
  const injectedBackend = vi.fn(() => backend);
  expect(graderBackend(definition, { backend: injectedBackend })).toBe(backend);
  expect(injectedBackend).toHaveBeenCalledExactlyOnceWith(definition);
  expect(createTeacherDecision).toHaveBeenCalledTimes(2);
});
it('pins authored route, reported identity and teacher policy in cache identity', async () => {
  const definition = grader({ backend: 'teacher', teacher: 'c' });
  const identity = await backendIdentity(definition, backend);
  expect(identity).toBe(stableDigest({ configured: definition.model, reported: await backend.identity(), teacher: definition.teachers[0] }));
  expect(await backendIdentity({ ...definition, teachers: [{ ...definition.teachers[0]!, model: 'changed' }] }, backend)).not.toBe(identity);
  const local = grader({ backend: 'ollama-logprobs', endpoint: 'http://localhost', name: 'local' });
  expect(await backendIdentity(local, backend)).toBe(stableDigest({ configured: local.model, reported: await backend.identity() }));
  const changed = { ...backend, identity: async () => ({ backend: 'fake', model: 'different' }) };
  expect(await backendIdentity(local, changed)).not.toBe(await backendIdentity(local, backend));
});

it('passes authored context through backend construction', () => {
  graderBackend(grader({ backend: 'ollama-logprobs', endpoint: 'http://localhost', name: 'local', context_tokens: 32768 }));
  expect(createOllamaDecision).toHaveBeenCalledExactlyOnceWith({ endpoint: 'http://localhost', model: 'local', contextTokens: 32768 });
});
