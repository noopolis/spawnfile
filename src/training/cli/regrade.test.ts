import '../../../fixtures/support/training/graderProviders.js';
import { expect, it } from 'vitest';
import { parseGrader } from '../graders/index.js';
import { graderHostProviders } from './regrade.js';

it('selects the extractor, decision and escalation services that a saved trial can call', () => {
  const definition = { schema: 'spawnfile.training.grader.v1', id: 'writing', golden: 'gold.yaml', calibration: 'cal.json',
    teachers: [{ id: 'primary', provider: 'codex', model: 'first' }, { id: 'second', provider: 'grok', model: 'second' }],
    escalate: { to: 'second', between: [0.3, 0.7] }, model: { backend: 'teacher', teacher: 'primary' },
    questions: [{ id: 'q', type: 'yes-no', expected: 'yes', reads: ['output.body'] }], score: { method: 'weighted' } };
  const grader = parseGrader(definition);
  expect(graderHostProviders(grader, false)).toEqual(['codex-subscription']);
  expect(graderHostProviders(grader, true)).toEqual(['codex-subscription', 'grok-subscription']);
  const local = parseGrader({ ...definition, model: { backend: 'ollama-logprobs', endpoint: 'http://localhost:1234', name: 'local' } });
  expect(graderHostProviders(local, false)).toEqual([]);
  const atomic = { extractor: { id: 'reader', provider: 'codex', model: 'local-fixture', deadline_ms: 1000 } };
  expect(graderHostProviders(atomic, false)).toEqual(['codex-subscription']);
});
