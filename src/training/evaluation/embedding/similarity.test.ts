import { describe, expect, it } from 'vitest';
import { cosine } from './index.js';
import { evaluateNode, createEvaluationRegistry } from '../index.js';
import { evaluationContext, snapshot } from '../../testing/index.js';
import type { EmbeddingProvider } from '../../contracts/evaluation.js';

const check = { eval: 'embedding-similarity', input: 'output.text', reference: 'reference.txt',
  provider: 'local', model: 'test-vector', metric: 'cosine', calibration: 'calibration.json', minimum: 0.8 };
const registry = createEvaluationRegistry();
describe('embedding evaluation', () => {
  it('validates vector geometry rather than accepting invented similarity', () => {
    expect(cosine([1, 0], [1, 0])).toBe(1);expect(cosine([1, 0], [-1, 0])).toBe(-1);
    for (const [first, second] of [[[], []], [[1], [1, 2]], [[NaN], [1]], [[0], [0]], [[Infinity], [1]], [[1e308], [1e308]]]) {
      expect(() => cosine(first!, second!)).toThrow();
    }
  });
  it('requires explicit provider/model calibration, handles bad responses and accounts usage', async () => {
    const provider: EmbeddingProvider = { id: 'local', version: '1', embed: async () => ({ vectors: [[1, 0], [1, 0]], usage: null }) };
    const context = evaluationContext({ embeddings: { local: provider }, readText: async path => path === 'calibration.json'
      ? JSON.stringify({ model: 'test-vector', metric: 'cosine', version: '1' }) : 'reference' });
    expect((await evaluateNode(check, context, registry)).status).toBe('pass');
    expect((await evaluateNode(check, evaluationContext(), registry)).status).toBe('error');
    expect((await evaluateNode({ ...check, input: 'artifact:missing' }, context, registry)).status).toBe('unknown');
    for (const calibration of [null, {}, { model: 'other' }, { model: 'test-vector', metric: 'other' },
      { model: 'test-vector', metric: 'cosine' }]) {
      expect((await evaluateNode(check, { ...context, readText: async () => JSON.stringify(calibration) }, registry)).status).toBe('error');
    }
    const usage = { inputTokens: 3, cachedInputTokens: null, outputTokens: null, reasoningTokens: null, source: 'embedding' };
    provider.embed = async () => ({ vectors: [[1, 0], [-1, 0]], usage });
    const failed = await evaluateNode(check, { ...context, snapshot: snapshot({ closed: false }) }, registry);
    expect(failed.status).toBe('fail');expect(failed.score).toBe(0);expect(failed.usage?.[0]).toEqual(usage);
    provider.embed = async () => ({ vectors: [[1]], usage: null });
    expect((await evaluateNode(check, context, registry)).status).toBe('error');
  });
});
