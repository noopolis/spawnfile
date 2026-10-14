import { expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { parseAtomicGrader, type AtomicRuntime } from '../graders/atomic/index.js';
import { parseCheckTemplates, parseDecomposition } from '../graders/decomposition/index.js';
import { parseDatasetYaml, resolveDataset } from '../cases/index.js';
import { evaluationContext, artifact, snapshot } from '../testing/index.js';
import { createEvaluationRegistry, evaluateNode } from './index.js';
import { evaluateAtomicGrader } from './atomic-grader.js';

function fixture() {
  const grader = parseAtomicGrader({ schema: 'paideia.atomic-grader.v1', id: 'quality', templates: 'templates.yaml',
    extractor: { provider: 'codex', model: 'test' }, decision: { backend: 'typesafe', model: 'jev-1.0.0', max_spend_usd: 1 }, missing: 'unknown',
    aggregation: { method: 'gates-times-coverage-times-quality', critical_pass_at: 0.8, pass_at: 0.5, obligation_kinds: ['obligation'],
      dimensions: { coverage: { weight: 1, budget: 2 } }, penalties: { critical: 1, major: 0.5, minor: 0.1 } } });
  const templates = parseCheckTemplates({ schema: 'paideia.check-templates.v1', context: { assignment: { role: 'assignment' } },
    templates: [{ id: 'covered', applies_to: 'obligation', type: 'choice', instructions: 'Covered?', criteria: { yes: 'Good', no: 'Bad' },
      expected: ['yes'], state: ['unit', 'output.body'], dimension: 'coverage', severity: 'major' }] });
  const check = { id: 'quality', eval: 'grader', grader: '/grader.yaml', input: 'artifact:article', context: { assignment: 'artifact:assignment' },
    grader_binding: { kind: 'atomic', definitionDigest: 'a'.repeat(64), templatesDigest: 'b'.repeat(64), gates: [] } };
  const receipt = { provider: 'codex', model: 'test', prompt_digest: 'c'.repeat(64), at: '2026-10-14T00:00:00Z' };
  const runtime: AtomicRuntime = { kind: 'atomic', grader, templates, definitionDigest: 'a'.repeat(64), templatesDigest: 'b'.repeat(64), resource: {},
    backend: { identity: vi.fn(async () => ({ backend: 'typesafe', model: 'jev-1.0.0' })), score: vi.fn<AtomicRuntime['backend']['score']>(async requests =>
      requests.map(request => ({ key: request.key, status: 'ok', probabilities: { yes: 1, no: 0 } }))) },
    extract: vi.fn(async () => ({ decomposition: parseDecomposition({ schema: 'paideia.decomposition.v1', output: { from: 'trial', sha256: 'c'.repeat(64) },
      units: [{ id: 'one', kind: 'obligation', text: 'Cover Alice.' }], extractors: [receipt], audit: { extractor: receipt, missed: [], at: receipt.at } }),
    receipts: [], judgeCalls: [] })) };
  const context = evaluationContext({ graders: { '/grader.yaml': runtime }, snapshot: snapshot({ artifacts: {
    article: artifact({ body: ['Alice joined.'] }),
    assignment: { ...artifact('Cover Alice.'), name: 'assignment' },
  } }) });
  return { check, context, runtime };
}

it('requires accepted artifacts and exact frozen identity before any extraction', async () => {
  const f = fixture(), registry = createEvaluationRegistry();
  const first = await evaluateNode(f.check, f.context, registry);
  expect(first.status, JSON.stringify({ reason: first.reason, grade: first.atomicGrading?.checks })).toBe('pass');
  vi.mocked(f.runtime.extract).mockClear();
  for (const change of [{ definitionDigest: 'c'.repeat(64) }, { templatesDigest: 'c'.repeat(64) }, { kind: undefined, calibrationDigest: 'c'.repeat(64) }]) {
    const check = { ...f.check, grader_binding: { ...f.check.grader_binding, ...change } };
    expect((await evaluateNode(check, f.context, registry)).reason).toContain('identity');
  }
  for (const artifacts of [{}, { article: { ...artifact({ body: ['Unaccepted'] }), acceptedCallId: undefined } }]) {
    expect((await evaluateNode(f.check, { ...f.context, snapshot: snapshot({ artifacts: artifacts as import('../contracts/evaluation.js').EvaluationSnapshot['artifacts'] }) }, registry)).status).toBe('unknown');
  }
  const unaccepted = { ...f.context.snapshot, artifacts: { ...f.context.snapshot.artifacts,
    article: { ...f.context.snapshot.artifacts.article!, acceptedCallId: undefined } } };
  expect((await evaluateNode(f.check, { ...f.context, snapshot: unaccepted }, registry)).reason).toContain('Accepted graded artifact');
  expect(f.runtime.extract).not.toHaveBeenCalled();
  expect((await evaluateNode({ ...f.check, context: { unknown: 'input:files' } }, f.context, registry)).reason).toContain('Unknown grader context');
  for (const context of [undefined, {}, { assignment: 'artifact:absent' }]) {
    expect((await evaluateNode({ ...f.check, context }, f.context, registry))).toMatchObject({ status: 'unknown', score: 0 });
  }
  f.runtime.grader.missing = 'fail';
  expect((await evaluateNode({ ...f.check, context: {} }, f.context, registry)).status).toBe('fail');
});

it('evaluates acceptance gates against the same artifact and stops inference on failed or errored gates', async () => {
  const f = fixture();
  const check = { ...f.check, grader_binding: { ...f.check.grader_binding, gates: [{ id: 'accepted', check: { eval: 'equals', input: 'artifact:article', value: 'wrong' } }] } };
  const result = await evaluateNode(check, f.context, createEvaluationRegistry());
  expect(result).toMatchObject({ status: 'fail', score: 0, children: [{ id: 'accepted', status: 'fail' }] });
  expect(f.runtime.extract).not.toHaveBeenCalled();
  await expect(evaluateAtomicGrader(check, f.context, f.runtime)).rejects.toThrow('evaluation engine');
  const evaluateCheck = vi.fn(async () => ({ status: 'error' as const, finality: 'final' as const, reason: 'Failed', evidence: [] }));
  expect((await evaluateAtomicGrader(check, { ...f.context, evaluateCheck }, f.runtime)).status).toBe('error');
  expect(evaluateCheck.mock.calls[0]).toEqual([check.grader_binding.gates[0]!.check, f.context.snapshot.artifacts.article]);
  for (const status of ['unknown', 'skipped', 'pass'] as const) {
    const result = await evaluateAtomicGrader(check, { ...f.context, evaluateCheck: async () => ({ status, finality: 'final', reason: 'Gate', evidence: [{ kind: 'event', id: 'gate' }] }) }, f.runtime);
    expect(result.status).toBe(status === 'pass' ? 'pass' : 'unknown');
    expect(result.evidence).toContainEqual({ kind: 'event', id: 'gate' });
  }
  vi.mocked(f.runtime.extract).mockResolvedValue({ receipts: [], judgeCalls: [], error: 'Infrastructure' });
  expect((await evaluateAtomicGrader(f.check, f.context, f.runtime)).status).toBe('error');
});

it('freezes atomic sidecars and refuses unbound, recursive or bypassable acceptance gates at resolution', () => {
  const f = fixture();
  function resolve(gates: unknown[] = [], context: unknown = f.check.context, templates = f.runtime.templates) {
    const resources: Record<string, string> = { 'grader.yaml': stringify({ ...f.runtime.grader, gates }), 'templates.yaml': stringify(templates) };
    return resolveDataset(parseDatasetYaml(stringify({ schema: 'paideia.dataset.v1', id: 'd', checks: [{ ...f.check, grader: 'grader.yaml', grader_binding: undefined, context }],
      records: [{ id: 'one', input: { prompt: 'Write' }, outputs: { article: 'out.json' } }] }), { sourceName: '/dataset.yaml' }), {
      readCriterionFile: name => resources[name]!, registry: { rulesets: { hidden: { version: '1', expand: () => ({ eval: 'tool-called', tool: 'save' }) } } } });
  }
  const resolved = resolve();
  expect(resolved.sharedStages[0]!.checks[0]!.grader_binding).toMatchObject({ kind: 'atomic', gates: [], definitionDigest: expect.stringMatching(/^[a-f0-9]{64}$/), templatesDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(resolve([], undefined).sharedStages).toHaveLength(1);
  expect(() => resolve([], {})).toThrow('unbound grader context');
  expect(() => resolve([], { unknown: 'input:files' })).toThrow('unknown grader context');
  expect(() => resolve([{ id: 'bypass', check: { use: 'hidden' } }])).toThrow('unbound tool gate');
  expect(() => resolve([{ id: 'nested', check: { eval: 'grader', grader: 'grader.yaml', input: 'artifact:article' } }])).toThrow('nested graders');
  expect(() => resolve([{ id: 'wrong', check: { eval: 'equals', input: 'artifact:other', value: 'x' } }])).toThrow('graded artifact');
  expect(() => resolve([{ id: 'tool', check: { eval: 'tool-sequence', order: 'happens-before', ending_at: { artifact: 'article', event: 'accepted-call' },
    steps: [{ tool: 'validate', bind: { article: 'call.args.article' } }, { tool: 'save', where: { cel: 'true || call.args.article == bindings.article' } }] } }])).toThrow('must require argument equality');
  const inline = { ...f.check, grader_binding: { ...f.check.grader_binding, kind: 'wrong' } };
  expect(() => resolveDataset(parseDatasetYaml(stringify({ schema: 'paideia.dataset.v1', id: 'd', checks: [inline], records: [{ id: 'one', input: {} }] })))).toThrow('kind');
});
