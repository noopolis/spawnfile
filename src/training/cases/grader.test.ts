import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { createCalibrationIdentity, parseGrader, sha256 } from '../graders/index.js';
import { parseDatasetYaml, resolveDataset } from './index.js';
import { validateGraderParameters } from './grader.js';
import { resolveStages } from './plans.js';

const grader = parseGrader({ schema: 'paideia.grader.v1', id: 'report', golden: 'golden.yaml', calibration: 'calibration.json',
  context: { evidence: { description: 'Sources' } }, teachers: [{ id: 'teacher', provider: 'claude', model: 'model' }],
  model: { backend: 'ollama-logprobs', endpoint: 'http://localhost:11434', name: 'model' },
  escalate: { to: 'teacher', between: [0.4, 0.6] }, questions: [{ id: 'clear', type: 'yes-no', expected: 'yes', reads: ['context.evidence', 'output.body'] }],
  score: { method: 'weighted' } });
const calibration = { schema: 'paideia.grader-calibration.v1', identity: createCalibrationIdentity(grader, {
  backendModel: 'model', promptTemplateVersion: 'v1', golden: 'a'.repeat(64), seed: '', exclusions: [],
}), questions: {} };
const check = { id: 'quality', eval: 'grader', grader: 'rubrics/report.yaml', input: 'artifact:article', context: { evidence: 'input:files' } };
function resolve(overrides: Record<string, unknown> = {}, file = grader, source = JSON.stringify(calibration)) {
  const resources: Record<string, string> = { 'rubrics/report.yaml': stringify(file), 'rubrics/calibration.json': source };
  return resolveDataset(parseDatasetYaml(stringify({ schema: 'paideia.dataset.v1', id: 'dataset', checks: [{ ...check, ...overrides }],
    records: [{ id: 'r', input: { prompt: 'Write' }, outputs: { article: 'out.json' } }] }), { sourceName: '/project/dataset.yaml' }), {
    readCriterionFile: path => { if (!resources[path]) throw new Error('missing file'); return resources[path]; },
  });
}
describe('grader resolution', () => {
  it('loads relative protected resources and binds their digests to resolved checks and plan identity', () => {
    const resolved = resolve();
    const node = resolved.records[0]!.effectiveStages[0]!.checks[0]!;
    expect(node.grader).toBe('/project/rubrics/report.yaml');
    expect(node.grader_binding).toEqual({ definitionDigest: sha256(stringify(grader)), calibrationDigest: sha256(JSON.stringify(calibration)), gates: [] });
    expect(resolved.registryVersions['grader:rubrics/report.yaml']).toContain(sha256(stringify(grader)));
    expect(resolve({}, { ...grader, score: { method: 'weighted', pass_at: 0.7 } }).sharedPlanDigest).not.toBe(resolved.sharedPlanDigest);
    expect(resolve({}, grader, JSON.stringify({ ...calibration, identity: { ...calibration.identity, seed: 'new' } })).sharedPlanDigest).not.toBe(resolved.sharedPlanDigest);
  });
  it('authenticates original bytes including YAML BOM and checks structured predicate context', () => {
    const source = `\uFEFF${stringify(grader)}`;
    const context = { registry: {}, versions: {}, criterionFileDigests: {}, readCriterionFile: (name: string) =>
      Buffer.from(name.endsWith('.yaml') ? source : JSON.stringify(calibration)) };
    const resolved = resolveStages([{ id: 's', checks: [check] }], context);
    expect(resolved[0]!.checks[0]!.grader_binding).toMatchObject({ definitionDigest: sha256(source) });
    const conditional = { ...grader, questions: [{ ...grader.questions[0]!, reads: ['output.body'], when: { field: 'context.evidence', equals: {} } }] };
    expect(() => resolve({ context: {} }, conditional)).toThrow('unbound grader context evidence');
    expect(resolve({}, conditional).sharedStages).toHaveLength(1);
  });
  it('rejects absent bindings, unknown names, invalid files and missing calibration', () => {
    expect(() => resolve({ context: {} })).toThrow('unbound grader context evidence');
    expect(() => resolve({ context: { other: 'input:files' } })).toThrow('unknown grader context other');
    expect(() => resolve({}, { ...grader, calibration: 'absent.json' })).toThrow('absent.json');
    expect(() => resolve({}, { ...grader, score: { method: 'fitted-weights', pass_at: 0 } })).toThrow('not implemented');
    expect(() => resolve({}, grader, '{}')).toThrow('schema');
    expect(() => resolveStages([{ id: 's', checks: [check] }], { registry: {}, versions: {} })).toThrow('protected bytes');
  });
  it('validates authored selectors and internal digest shapes', () => {
    for (const changed of [{ input: 'output.text' }, { context: { evidence: 'invalid' } }, { grader: '../file' }]) {
      expect(() => validateGraderParameters({ ...check, ...changed }, '$')).toThrow();
    }
    const binding = { definitionDigest: 'a'.repeat(64), calibrationDigest: 'b'.repeat(64), gates: [] };
    expect(() => validateGraderParameters({ ...check, grader_binding: binding }, '$')).not.toThrow();
    expect(() => validateGraderParameters({ ...check, context: undefined }, '$')).not.toThrow();
    expect(() => validateGraderParameters({ ...check, grader_binding: { ...binding, definitionDigest: 'bad' } }, '$')).toThrow('definitionDigest');
    expect(() => validateGraderParameters({ ...check, grader_binding: { ...binding, gates: {} } }, '$')).toThrow('gates');
  });
  it('revalidates gate binding after ruleset expansion', () => {
    const withRule = { ...grader, gates: [{ id: 'gate', check: { use: 'hidden' } }] };
    const resources: Record<string, string> = { 'rubrics/report.yaml': stringify(withRule), 'rubrics/calibration.json': JSON.stringify(calibration) };
    expect(() => resolveStages([{ id: 's', checks: [check] }], { versions: {}, criterionFileDigests: {},
      readCriterionFile: name => resources[name]!, registry: { rulesets: { hidden: { version: '1', expand: () => ({ eval: 'tool-called', tool: 'save' }) } } },
    })).toThrow('unbound tool gate');
  });
  it('resolves nested gates using the existing registry and authentic artifact name', () => {
    const gate = { id: 'valid', check: { all: [{ not: { eval: 'equals', input: 'artifact:article', value: 'bad' } }] } };
    expect((resolve({}, { ...grader, gates: [gate] }).sharedStages[0]!.checks[0]!.grader_binding as { gates: unknown[] }).gates).toHaveLength(1);
    const sequence = { eval: 'tool-sequence', order: 'happens-before', ending_at: { artifact: 'other', event: 'accepted-call' },
      steps: [{ tool: 'validate', bind: { value: 'call.args.value' } }, { tool: 'save', where: { cel: 'call.args.value == bindings.value' } }] };
    expect(() => resolve({}, { ...grader, gates: [{ id: 'bound', check: sequence }] })).toThrow('graded artifact article');
    expect(() => resolve({}, { ...grader, gates: [{ id: 'nested', check }] })).toThrow('nested graders');
    for (const input of ['output.text', 'artifact:other']) {
      expect(() => resolve({}, { ...grader, gates: [{ id: 'bad-input', check: { eval: 'equals', input, value: 'x' } }] })).toThrow('graded artifact article');
    }
    expect(resolve({}, { ...grader, gates: [{ id: 'bound-input', check: { eval: 'equals', input: 'artifact:article#/body', value: [] } }] }).sharedStages).toHaveLength(1);
    expect(() => resolve({}, { ...grader, gates: [{ id: 'bad', check: { eval: 'unknown' } }] })).toThrow('unsupported evaluator');
  });
});
