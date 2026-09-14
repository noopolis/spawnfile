import { describe, expect, it, vi } from 'vitest';
import { dspyEnvironment, runDspyOptimization } from './runner.js';
import { DSPY_SCHEMA } from './protocol.js';
import { DspyOptimizationError, type DspyOptimizationOptions } from './types.js';
import { scriptBridge, simulatedOptions } from './testSupport.js';

describe('actual TypeScript → DSPy GEPA bridge', () => {
  it('observes real multi-file optimization, complete validation and exact original bytes', async () => {
    const { options, evaluations, generations } = simulatedOptions();
    const validate = vi.spyOn(options, 'validateComponents');
    const result = await runDspyOptimization(options);
    expect(result.provenance).toMatchObject({ optimizer: 'dspy.GEPA', dspyVersion: '3.3.1', gepaVersion: '0.1.4',
      evaluations: 7, proposals: 2, selectedCandidateIndex: 2 });
    expect(result.provenance.candidates.map((candidate) => candidate.validationScore)).toEqual([0, 0.5, 1]);
    expect(evaluations[0]?.components).toEqual(options.components);
    expect(evaluations.at(-1)?.components).toEqual(result.components);
    expect(result.components['AGENTS.md']).toBe('\n  Keep identity.\n\nRevision 1.\nRevision 2.\n');
    expect(generations).toHaveLength(2);
    expect(JSON.stringify(generations)).not.toContain('validation-secret');
    expect(validate).toHaveBeenCalledTimes(11); // initial + seven trials + three final candidates
    expect(result.provenance.generations).toEqual([{ model: 'simulated-subscription', usage: null },
      { model: 'simulated-subscription', usage: null }]);
  });

  it('enforces locked text before a changed candidate can reach a trial', async () => {
    const { options, evaluations } = simulatedOptions();
    options.validateComponents = (components) => {
      if (components['AGENTS.md'] !== options.components['AGENTS.md']) throw new Error('locked identity changed');
    };
    await expect(runDspyOptimization(options)).rejects.toMatchObject({ name: 'DspyOptimizationError',
      message: 'locked identity changed', evidence: { evaluations: 2, proposals: 1 } });
    expect(evaluations).toHaveLength(2);
    expect(evaluations.every((entry) => entry.components['AGENTS.md'] === options.components['AGENTS.md'])).toBe(true);
  });

  it('round-trips explicit requested and reported model attribution through real DSPy', async () => {
    const { options } = simulatedOptions();
    const generate = options.generate;
    let index = 0;
    options.generate = async (request, signal) => ({ ...await generate(request, signal),
      modelBasis: index++ === 0 ? 'requested-assumption' : 'provider-reported' });
    const result = await runDspyOptimization(options);
    expect(result.provenance.generations).toEqual([
      { model: 'simulated-subscription', usage: null, modelBasis: 'requested-assumption' },
      { model: 'simulated-subscription', usage: null, modelBasis: 'provider-reported' },
    ]);
  });

  it('returns an explicit baseline-only result when a full optimization iteration cannot fit', async () => {
    const { options } = simulatedOptions();
    options.seed = undefined;
    options.budget.maxMetricCalls = 1;
    const result = await runDspyOptimization(options);
    expect(result.provenance).toMatchObject({ evaluations: 1, proposals: 0, seed: 0 });
    expect(result.components).toEqual(options.components);
  });

  it('rejects sealed-test options, invalid bounds and split overlap before process launch', async () => {
    const { options } = simulatedOptions();
    await expect(runDspyOptimization({ ...options, testCaseIds: ['sealed'] } as DspyOptimizationOptions)).rejects.toThrow('sealed-test');
    await expect(runDspyOptimization({ ...options, bridge: { ...options.bridge, timeoutMs: 0 } })).rejects.toThrow('positive');
    await expect(runDspyOptimization({ ...options, validationCaseIds: ['train'] })).rejects.toThrow('disjoint');
  });
});

describe('protocol/process failures', () => {
  it.each([
    ['process.exit(0)', 'omitted its terminal'],
    ['process.exit(3)', 'unsuccessfully (3)'],
    ['console.log("not JSON")', 'JSON'],
    [`console.log(JSON.stringify({schema:'${DSPY_SCHEMA}',kind:'error',id:'typescript-gepa',error:{code:'quota_exhausted',message:'no quota'}}))`, 'quota_exhausted'],
    ['process.stdout.write("{}")', 'line terminator'],
  ])('does not confuse launch/exit with optimization: %s', async (code, message) => {
    const { options } = simulatedOptions();
    options.bridge = scriptBridge(code);
    await expect(runDspyOptimization(options)).rejects.toMatchObject({ name: 'DspyOptimizationError', message: expect.stringContaining(message) });
  });

  it('reports failed executable launch with zero host attempts', async () => {
    const { options } = simulatedOptions();
    options.bridge.command = '/missing-paideia-dspy';
    await expect(runDspyOptimization(options)).rejects.toMatchObject({ evidence: { evaluations: 0, proposals: 0, hostWork: 'settled' },
      message: expect.stringContaining('ENOENT') });
  });

  it('rejects extra data after a plausible terminal envelope', async () => {
    const { options } = simulatedOptions();
    const real = await runDspyOptimization(options);
    options.bridge = scriptBridge(`console.log(${JSON.stringify(JSON.stringify(real))});console.log('{}')`);
    await expect(runDspyOptimization(options)).rejects.toThrow('after its terminal');
  });

  it('rejects invented terminal provenance despite exit zero', async () => {
    const { options } = simulatedOptions();
    const real = await runDspyOptimization(options);
    options.bridge = scriptBridge(`console.log(${JSON.stringify(JSON.stringify(real))})`);
    await expect(runDspyOptimization(options)).rejects.toThrow('host evidence');
  });

  it('strips credential/provider environment values from the Python process', () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-secret');
    vi.stubEnv('PYTHONPATH', '/injected');
    vi.stubEnv('PATH', '/bin');
    vi.stubEnv('HOME', '/ambient-secret-home');
    try {
      expect(dspyEnvironment('/fresh-home')).toMatchObject({ HOME: '/fresh-home', PATH: '/bin', PYTHONNOUSERSITE: '1' });
      expect(dspyEnvironment('/fresh-home')).not.toHaveProperty('OPENAI_API_KEY');
      expect(dspyEnvironment('/fresh-home')).not.toHaveProperty('PYTHONPATH');
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('owned cancellation', () => {
  it('does not launch after an already-aborted request', async () => {
    const { options } = simulatedOptions();
    options.signal = AbortSignal.abort();
    options.bridge.command = '/must-not-launch';
    await expect(runDspyOptimization(options)).rejects.toMatchObject({ code: 'cancelled',
      evidence: { evaluations: 0, proposals: 0, hostWork: 'settled' } });
  });

  it('propagates cancellation to a running host trial and confirms Python group termination', async () => {
    const { options } = simulatedOptions();
    const controller = new AbortController();
    options.signal = controller.signal;
    options.evaluate = async (_request, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('native trial stopped')), { once: true });
      controller.abort();
    });
    await expect(runDspyOptimization(options)).rejects.toMatchObject({ code: 'cancelled', evidence: {
      evaluations: 1, hostWork: 'settled', stop: { state: 'acknowledged', quiescence: 'confirmed' },
    } });
  });

  it('reports an uncooperative host as incomplete instead of waiting forever', async () => {
    const { options } = simulatedOptions();
    const controller = new AbortController();
    options.signal = controller.signal;
    let observed: AbortSignal | undefined;
    options.generate = async (_request, signal) => {
      observed = signal;
      controller.abort();
      return new Promise(() => undefined);
    };
    await expect(runDspyOptimization(options)).rejects.toMatchObject({ code: 'cancelled',
      evidence: { proposals: 1, hostWork: 'incomplete' } });
    expect(observed?.aborted).toBe(true);
  });

  it('bounds initial candidate validation and whole-process stalls', async () => {
    const { options } = simulatedOptions();
    options.bridge.timeoutMs = 25;
    options.validateComponents = () => new Promise(() => undefined);
    await expect(runDspyOptimization(options)).rejects.toMatchObject({ code: 'timeout', evidence: { hostWork: 'incomplete' } });
    options.validateComponents = () => undefined;
    options.bridge = { ...scriptBridge('setInterval(()=>{},10)'), timeoutMs: 30 };
    await expect(runDspyOptimization(options)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('retains host non-Error failures and counts failed evaluation attempts', async () => {
    const { options } = simulatedOptions();
    options.evaluate = async () => { throw 'host unavailable'; };
    await expect(runDspyOptimization(options)).rejects.toBeInstanceOf(DspyOptimizationError);
    options.validateComponents = () => { throw 'invalid resource'; };
    await expect(runDspyOptimization(options)).rejects.toMatchObject({ message: 'invalid resource', evidence: { evaluations: 0 } });
  });
});
it('retains host fallback receipts while keeping the actual DSPy wire protocol unchanged', async () => {
  const { options } = simulatedOptions();
  const generate = options.generate;
  const attempts = [{ id: 'receipt', ordinal: 1, providerId: 'local', requestedModel: 'small', responseModel: 'actual',
    responseRoute: 'local', outcome: 'completed' as const, failureKind: null, startedAt: 'start', completedAt: 'end', usage: null }];
  options.generate = async (request, signal) => ({ ...await generate(request, signal), attempts });
  const result = await runDspyOptimization(options);
  expect(result.provenance.generations).toHaveLength(2);
  expect(result.provenance.generations.every(generation => JSON.stringify(generation.attempts) === JSON.stringify(attempts))).toBe(true);
});
