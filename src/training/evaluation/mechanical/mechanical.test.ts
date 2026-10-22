import { describe, expect, it } from 'vitest';
import { evaluationContext, snapshot, observation, artifact } from '../../testing/index.js';
import { evaluateNode, createEvaluationRegistry, selectEvidence, ownPath } from '../index.js';
import { predicate, bindingValue, evaluateText, evaluateTool } from './index.js';

const registry = createEvaluationRegistry();
describe('mechanical evidence', () => {
  it('enforces required-only schemas without mutating the article or adding constraints', async () => {
    const schema = { type: 'object', required: ['id', 'title', 'author', 'evidence', 'assignment'],
      properties: { id: { const: 'synthetic-article' } } };
    const value = { id: 'synthetic-article', title: 'Title', author: 'Writer', evidence: {}, assignment: 'one' };
    const check = { eval: 'json-schema', input: 'artifact:article', schema };
    const context = evaluationContext({ snapshot: snapshot({ artifacts: { article: artifact(value) } }) });
    expect((await evaluateNode(check, context, registry)).status).toBe('pass');
    expect(context.snapshot.artifacts['article']!.value).toEqual(value);
    for (const field of schema.required) {
      const missing: Record<string, unknown> = { ...value }; delete missing[field];
      const mutated = evaluationContext({ snapshot: snapshot({ artifacts: { article: artifact(missing) } }) });
      expect((await evaluateNode(check, mutated, registry)).status).toBe('fail');
    }
    const wrongId = evaluationContext({ snapshot: snapshot({ artifacts: { article: artifact({ ...value, id: 'other' }) } }) });
    expect((await evaluateNode(check, wrongId, registry)).status).toBe('fail');
  });
  it('cannot certify text equality from absent or partial output', async () => {
    for (const coverage of [[], [{ channel: 'output' as const, completeness: 'partial' as const, ordering: 'source' as const }]]) {
      const evaluated = await evaluateNode({ eval: 'equals', input: 'output.text', value: '4' },
        evaluationContext({ snapshot: snapshot({ coverage }) }), registry);
      expect(evaluated.status).toBe('unknown');
      expect(evaluated.finality).toBe('final');
    }
  });
  it('selects exact snapshots with safe JSON pointers and missing evidence', () => {
    const snap = snapshot({ artifacts: { article: artifact({ 'a/b': { '~key': 7 } }) } });
    expect(selectEvidence('artifact:article#/a~1b/~0key', snap).value).toBe(7);
    expect(selectEvidence('artifact:article#/missing', snap).found).toBe(false);
    expect(selectEvidence('artifact:missing', snap).found).toBe(false);
    expect(selectEvidence('input:files', snap).evidence[0]!.kind).toBe('input');
    expect(selectEvidence('output.text', snap).value).toBe('4');
    for (const selector of ['bad', 'artifact:article#bad', 'artifact:article#/~2', 'artifact:article#/~']) {
      expect(() => selectEvidence(selector, snap)).toThrow();
    }
    expect(ownPath({}, ['__proto__'])).toBeUndefined();
    expect(ownPath(null, ['field'])).toBeUndefined();
    expect(bindingValue('call.args.value', { call: { args: { value: 4 } } })).toBe(4);
  });
  it('checks text and JSON shape without pretending they prove source truth', async () => {
    const context = evaluationContext();
    expect((await evaluateNode({ eval: 'equals', input: 'output.text', value: '4' }, context, registry)).status).toBe('pass');
    expect((await evaluateNode({ eval: 'equals', input: 'output.text', value: 4 }, context, registry)).status).toBe('fail');
    expect((await evaluateNode({ eval: 'contains-any', input: 'artifact:article#/body', values: ['precise'] }, context, registry)).status).toBe('pass');
    expect((await evaluateNode({ eval: 'contains-any', input: 'output.text', values: ['x'] }, context, registry)).status).toBe('fail');
    expect((await evaluateNode({ eval: 'contains-any', input: 'artifact:article', values: ['x'] }, context, registry)).status).toBe('error');
    expect((await evaluateNode({ eval: 'equals', input: 'artifact:none', value: 4 }, context, registry)).status).toBe('unknown');
    const check = { eval: 'json-schema', input: 'artifact:article',
      schema: { type: 'object', properties: { body: { type: 'array' } }, required: ['body'] } };
    expect((await evaluateNode(check, context, registry)).status).toBe('pass');
    expect((await evaluateNode({ ...check, schema: 'unregistered.json' }, context, registry)).reason).toContain('Sidecar not registered');
    expect((await evaluateNode({ ...check, schema: 'schema.json' }, { ...context,
      readText: async () => JSON.stringify({ type: 'object', properties: { headline: { type: 'string' } }, required: ['headline'] }) }, registry)).status).toBe('fail');
    await expect(evaluateText({ eval: 'unrecognized', input: 'output.text' }, context)).rejects.toThrow('Unknown');
    expect((await evaluateNode({ eval: 'equals', input: 'output.text', value: '4' },
      evaluationContext({ snapshot: snapshot({ closed: false }) }), registry)).finality).toBe('provisional');
  });
  it('separates an absence the run observed from one it could not make', async () => {
    const complete = { status: 'complete' as const, usage: null, settled: true };
    const check = { eval: 'contains-any', input: 'artifact:none#/body', values: ['Filed'] };
    const accounted = evaluationContext({ snapshot: snapshot({ subjectUsage: complete }) });
    const failed = await evaluateNode(check, accounted, registry);
    // The subject's run is fully accounted for and the artifact is not there: a measured zero
    // that keeps its weight, never an exclusion from the denominator.
    expect(failed.status).toBe('fail');
    expect(failed.finality).toBe('final');
    expect(failed.score).toBe(0);
    // Each conjunct is load-bearing on its own: drop any one and the verdict is unknown again.
    for (const overrides of [{}, { subjectUsage: { status: 'incomplete' as const, usage: null } },
      { subjectUsage: complete, closed: false }]) {
      expect((await evaluateNode(check, evaluationContext({ snapshot: snapshot(overrides) }), registry)).status).toBe('unknown');
    }
    // Settlement, not token accounting, is what certifies the absence: a retried attempt can leave
    // usage incomplete while the closed artifact collection is no less observed.
    const partialUsage = { status: 'incomplete' as const, usage: null, settled: true };
    expect((await evaluateNode(check, evaluationContext({ snapshot: snapshot({ subjectUsage: partialUsage }) }), registry)).status).toBe('fail');
    // An absent output is incomplete coverage by definition, so it can never certify absence.
    expect((await evaluateNode({ eval: 'equals', input: 'output.text', value: '4' },
      evaluationContext({ snapshot: snapshot({ coverage: [], subjectUsage: complete }) }), registry)).status).toBe('unknown');
  });
  it('makes presence decisive but cannot certify absence from partial capture', async () => {
    const first = observation();
    const end = observation({ id: 'end', seq: 2, type: 'tool.complete', success: false });
    const context = evaluationContext({ snapshot: snapshot({ events: [first, end], closed: false }) });
    const check = { eval: 'tool-called', tool: 'validate', phase: 'dispatch' };
    expect((await evaluateNode(check, context, registry)).finality).toBe('final');
    expect((await evaluateNode({ ...check, outcome: 'failed' }, context, registry)).status).toBe('pass');
    expect((await evaluateNode({ ...check, outcome: 'succeeded' }, context, registry)).status).toBe('unknown');
    expect((await evaluateNode({ eval: 'tool-called', tool: 'validate' }, context, registry)).status).toBe('pass');
    expect((await evaluateNode({ not: { ...check, tool: 'forbidden' } }, context, registry)).status).toBe('unknown');
    expect((await evaluateNode({ ...check, tool: 'missing' }, evaluationContext(), registry)).status).toBe('fail');
    const incomplete = evaluationContext({ snapshot: snapshot({ coverage: [], closed: true }) });
    expect((await evaluateNode({ ...check, tool: 'missing' }, incomplete, registry)).finality).toBe('final');
    expect((await evaluateNode({ eval: 'tool-count', tool: 'missing', exactly: 1 }, incomplete, registry)).finality).toBe('final');
    const completedOnly = evaluationContext({ snapshot: snapshot({ events: [end] }) });
    expect((await evaluateNode(check, completedOnly, registry)).status).toBe('fail');
    expect((await evaluateNode({ ...check, phase: 'completion' }, completedOnly, registry)).status).toBe('pass');
    expect((await evaluateNode({ eval: 'tool-called', tool: 'validate', phase: 'completion' },
      evaluationContext({ snapshot: snapshot({ events: [first] }) }), registry)).status).toBe('fail');
    await expect(evaluateTool({ eval: 'bad', tool: 'validate' }, context)).rejects.toThrow('Unknown');
  });
  it('proves only monotone count bounds early', async () => {
    const context = evaluationContext({ snapshot: snapshot({ events: [observation()], closed: false }) });
    for (const bound of [{ exactly: 0 }, { at_most: 0 }]) {
      expect((await evaluateNode({ eval: 'tool-count', tool: 'validate', ...bound }, context, registry)).status).toBe('fail');
    }
    expect((await evaluateNode({ eval: 'tool-count', tool: 'validate', at_least: 1 }, context, registry)).status).toBe('pass');
    expect((await evaluateNode({ eval: 'tool-count', tool: 'validate', exactly: 1 }, context, registry)).status).toBe('unknown');
    const closed = { ...context, snapshot: { ...context.snapshot, closed: true } };
    expect((await evaluateNode({ eval: 'tool-count', tool: 'validate', exactly: 1 }, closed, registry)).status).toBe('pass');
    expect((await evaluateNode({ eval: 'tool-count', tool: 'validate', at_least: 2 }, closed, registry)).status).toBe('fail');
    expect((await evaluateNode({ eval: 'tool-count', tool: 'validate', at_most: 2 }, closed, registry)).status).toBe('pass');
  });
  it('evaluates CEL without executing JavaScript or inventing missing fields', () => {
    expect(predicate('call.success && call.args.article == bindings.article', {
      call: { success: true, args: { article: { a: 1, b: 2 } } }, bindings: { article: { b: 2, a: 1 } },
    })).toBe(true);
    expect(predicate('call.missing', { call: {} })).toBeUndefined();
    expect(() => predicate('1', {})).toThrow('boolean');
    expect(() => predicate('process.exit()', {})).toThrow();
    expect(() => predicate('x'.repeat(16_385), {})).toThrow('limit');
  });
});
