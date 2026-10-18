import { expect, it } from 'vitest';
import { runDspyOptimization } from './runner.js';
import { DSPY_SCHEMA } from './protocol.js';
import { scriptBridge, simulatedOptions } from './testSupport.js';

it('retains the initiating callback failure after cancelling and draining concurrent host work', async () => {
  const { options } = simulatedOptions();
  options.concurrency = 3;
  options.trainCaseIds = ['one', 'two', 'three'];
  options.bridge = scriptBridge(`
    for (const caseId of ['one', 'two', 'three']) console.log(JSON.stringify({
      schema: '${DSPY_SCHEMA}', kind: 'request', id: caseId, method: 'evaluate',
      params: { caseId, split: 'train', components: ${JSON.stringify(options.components)} }
    }));
    setInterval(() => {}, 10);
  `);
  let started = 0, cleaned = 0;
  let ready!: () => void;
  const allStarted = new Promise<void>(resolve => { ready = resolve; });
  options.evaluate = async (request, signal) => {
    if (++started === 3) ready();
    await allStarted;
    if (request.caseId === 'two') throw new Error('candidate publication failed');
    await new Promise<void>(resolve => signal.addEventListener('abort', () => { cleaned++; resolve(); }, { once: true }));
    throw new Error('sibling cancelled');
  };
  await expect(runDspyOptimization(options)).rejects.toMatchObject({
    code: 'optimization_failed', message: 'candidate publication failed',
    evidence: { evaluations: 3, hostWork: 'settled', stop: { quiescence: 'confirmed' } },
  });
  expect(started).toBe(3);
  expect(cleaned).toBe(2);
});
