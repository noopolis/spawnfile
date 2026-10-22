import { describe, expect, it } from 'vitest';
import type { Observation } from '../../contracts/execution.js';
import { evaluationContext, snapshot, observation, artifact } from '../../testing/index.js';
import { evaluateNode, createEvaluationRegistry } from '../index.js';
import { evaluateSequence } from './index.js';

const registry = createEvaluationRegistry();
function call(id: string, tool: string, seq: number, value = 'draft', success = true): Observation[] {
  return [observation({ id: `${id}-dispatch`, callId: id, tool, seq, args: { article: value } }),
    observation({ id: `${id}-complete`, callId: id, tool, seq: seq + 1, type: 'tool.complete',
      success, result: { valid: success } })];
}
const sequence = {
  eval: 'tool-sequence', order: 'happens-before',
  ending_at: { artifact: 'article', event: 'accepted-call' },
  steps: [{ tool: 'validate', where: { cel: 'call.success && call.result.valid' }, bind: { article: 'call.args.article' } },
    { tool: 'file', where: { cel: 'call.args.article == bindings.article' } }],
};
describe('ordered artifact-bound checks', () => {
  it('allows repair and unrelated work but binds the exact accepted version', async () => {
    const events = [...call('broken', 'validate', 1, 'bad', false), ...call('good', 'validate', 3),
      ...call('unrelated', 'read', 5), ...call('file', 'file', 7)];
    const context = evaluationContext({ snapshot: snapshot({ events: [...events].reverse() }) });
    const evaluated = await evaluateNode(sequence, context, registry);
    expect(evaluated.status).toBe('pass');
    expect(evaluated.evidence[0]).toEqual({ kind: 'artifact', id: 'checkpoint-1', digest: 'sha256:example' });
    expect(evaluated.evidence.map(item => item.id)).toEqual(['checkpoint-1', 'good-dispatch', 'good-complete', 'file-dispatch', 'file-complete']);
    const changed = [...events, ...call('late', 'file', 9, 'unvalidated')];
    const wrongVersion = { ...context, snapshot: snapshot({ events: changed,
      artifacts: { article: { ...artifact(), acceptedCallId: 'late' } } }) };
    expect((await evaluateNode(sequence, wrongVersion, registry)).status).toBe('fail');
    expect((await evaluateNode(sequence, { ...context, snapshot: { ...context.snapshot, closed: false } }, registry)).finality).toBe('provisional');
    const unbound = { eval: 'tool-sequence', order: 'happens-before', steps: [{ tool: 'validate' }, { tool: 'file' }] };
    expect((await evaluateNode(unbound, context, registry)).finality).toBe('final');
  });
  it('does not confuse reversed, missing or causally unobservable calls with success', async () => {
    const reversed = [...call('file', 'file', 1), ...call('good', 'validate', 3)];
    expect((await evaluateNode(sequence, evaluationContext({ snapshot: snapshot({ events: reversed }) }), registry)).status).toBe('fail');
    const independent = [...call('good', 'validate', 1), ...call('file', 'file', 3).map(event => ({ ...event, source: 'remote' }))];
    expect((await evaluateNode(sequence, evaluationContext({ snapshot: snapshot({ events: independent }) }), registry)).status).toBe('unknown');
    expect((await evaluateNode(sequence, evaluationContext(), registry)).evidence.some(item => item.kind === 'artifact')).toBe(true);
    const partial = evaluationContext({ snapshot: snapshot({ coverage: [], events: [] }) });
    expect((await evaluateNode(sequence, partial, registry)).status).toBe('unknown');
    expect((await evaluateNode(sequence, partial, registry)).finality).toBe('final');
    const missing = evaluationContext({ snapshot: snapshot({ artifacts: {} }) });
    expect((await evaluateNode(sequence, missing, registry)).status).toBe('unknown');
  });
  it('preserves unknown fields and refuses repeated-call witnesses', async () => {
    const events = [...call('good', 'validate', 1), ...call('file', 'file', 3)];
    const context = evaluationContext({ snapshot: snapshot({ events }) });
    const missingPredicate = { ...sequence, steps: [{ tool: 'validate', where: { cel: 'call.args.absent == true' } }] };
    // No call has the accepting identity and requested tool; complete evidence proves no tuple.
    expect((await evaluateNode(missingPredicate, context, registry)).status).toBe('fail');
    const unboundMissing = { ...missingPredicate, ending_at: undefined };
    expect((await evaluateNode(unboundMissing, context, registry)).status).toBe('unknown');
    const missingBinding = { ...sequence, ending_at: undefined,
      steps: [{ tool: 'validate', bind: { article: 'call.args.absent' } }] };
    expect((await evaluateNode(missingBinding, context, registry)).status).toBe('unknown');
    const repeated = { ...sequence, ending_at: undefined, steps: [{ tool: 'validate' }, { tool: 'validate' }] };
    expect((await evaluateNode(repeated, context, registry)).status).toBe('fail');
    await expect(evaluateSequence({ steps: [] }, context)).rejects.toThrow('steps');
  });
  it('bounds combinatorial matching instead of hanging the runner', async () => {
    const events = Array.from({ length: 70 }, (_, index) => call(`call-${index}`, 'repeat', index * 2)).flat();
    const context = evaluationContext({ snapshot: snapshot({ events }) });
    const large = { eval: 'tool-sequence', order: 'happens-before', steps: Array.from({ length: 5 }, () => ({ tool: 'repeat' })) };
    expect((await evaluateNode(large, context, registry)).reason).toContain('budget');
  });
});
