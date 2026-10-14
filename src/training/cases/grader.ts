import path from 'node:path';
import type { CheckNode } from '../contracts/dataset.js';
import { allQuestions, parseCalibrationJson, parseGraderYaml, sha256, validateGrader } from '../graders/index.js';
import { checkBinding, parseYaml } from '../graders/format/index.js';
import { parseAtomicGrader, validateAtomicTemplates } from '../graders/atomic/index.js';
import { parseCheckTemplatesYaml } from '../graders/decomposition/index.js';
import type { PlanResolution } from './plans.js';
import { fail, fields, object, safePath, string } from './validation.js';

export interface GraderBinding {
  definitionDigest: string;
  calibrationDigest?: string;
  kind?: 'atomic';
  templatesDigest?: string;
  gates: { id: string; check: CheckNode }[];
}

export function validateGraderParameters(parameters: Readonly<Record<string, unknown>>, location: string): void {
  const input = string(parameters.input, `${location}.input`);
  if (!/^artifact:[^#]+(?:#.*)?$/.test(input)) fail(`${location}.input`, 'grader requires an artifact selector');
  if (parameters.grader_binding === undefined) safePath(parameters.grader, `${location}.grader`);
  else {
    string(parameters.grader, `${location}.grader`);
    const binding = object(parameters.grader_binding, `${location}.grader_binding`);
    fields(binding, ['definitionDigest', 'calibrationDigest', 'kind', 'templatesDigest', 'gates'], `${location}.grader_binding`);
    if (binding.kind !== undefined && binding.kind !== 'atomic') fail(location, 'invalid grader binding kind');
    for (const key of ['definitionDigest', binding.kind === 'atomic' ? 'templatesDigest' : 'calibrationDigest']) {
      if (!/^[a-f0-9]{64}$/.test(string(binding[key], location))) fail(location, `invalid ${key}`);
    }
    if (!Array.isArray(binding.gates)) fail(location, 'grader binding gates must be an array');
  }
  for (const [name, selector] of Object.entries(object(parameters.context ?? {}, `${location}.context`))) {
    if (!/^(input:files|artifact:[^#]+(?:#.*)?)$/.test(string(selector, `${location}.context.${name}`))) {
      fail(`${location}.context.${name}`, 'unsupported trial context selector');
    }
  }
}

export function resolveGraderCheck(node: CheckNode, context: PlanResolution, location: string,
  resolveGate: (check: CheckNode, location: string) => CheckNode, isBuiltin: (name: string) => boolean): CheckNode {
  const filename = safePath(node.grader, `${location}.grader`);
  if (context.resolvingGrader) fail(location, 'nested graders are not supported as gates');
  context.resolvingGrader = true;
  try { return resolveGraderFile(node, context, location, resolveGate, filename, isBuiltin); }
  finally { context.resolvingGrader = false; }
}

function resolveGraderFile(node: CheckNode, context: PlanResolution, location: string,
  resolveGate: (check: CheckNode, location: string) => CheckNode, filename: string, isBuiltin: (name: string) => boolean): CheckNode {
  if (!context.readCriterionFile || !context.criterionFileDigests) fail(location, `grader requires protected bytes: ${filename}`);
  const read = (name: string): string => {
    const files = context.criterionFiles ??= new Map<string, Uint8Array>();
    let bytes = files.get(name);
    if (bytes === undefined) {
      try { bytes = Buffer.from(context.readCriterionFile!(name)); }
      catch (error) { fail(location, `cannot load grader resource ${name}: ${String(error)}`); }
      files.set(name, bytes);
    }
    const digest = sha256(bytes);
    context.criterionFileDigests![name] = `sha256:${digest}`;
    context.versions[`criterion-file:${name}`] = `sha256:${digest}`;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  };
  const source = read(filename);
  const parsed = parseYaml(source) as { schema?: string };
  const atomic = parsed?.schema === 'paideia.atomic-grader.v1' ? parseAtomicGrader(parsed) : undefined;
  const legacy = atomic ? undefined : validateGrader(parseGraderYaml(source));
  const resourcePath = safePath(path.posix.join(path.posix.dirname(filename), atomic?.templates ?? legacy!.calibration), `${location}.resource`);
  const resourceSource = read(resourcePath);
  const templates = atomic ? parseCheckTemplatesYaml(resourceSource) : undefined;
  if (atomic) validateAtomicTemplates(atomic, templates!);
  else parseCalibrationJson(resourceSource);
  const grader = legacy ?? { context: templates!.context, gates: atomic!.gates };
  const bindings = object(node.context ?? {}, `${location}.context`);
  for (const name of Object.keys(bindings)) {
    if (!Object.hasOwn(grader.context, name)) fail(location, `unknown grader context ${name}`);
  }
  if (atomic) for (const name of Object.keys(templates!.context)) {
    if (!Object.hasOwn(bindings, name)) fail(location, `unbound grader context ${name}`);
  }
  for (const question of legacy ? allQuestions(legacy) : []) {
    for (const selector of [...question.reads, ...(typeof question.when === 'object' ? [question.when.field] : [])]) {
      if (selector.startsWith('context.') && !Object.hasOwn(bindings, selector.slice(8))) {
        fail(location, `unbound grader context ${selector.slice(8)} in question ${question.id}`);
      }
    }
  }
  const gates = grader.gates.flatMap(gate => 'check' in gate
    ? [{ id: gate.id, check: resolveGate(gate.check as CheckNode, `${location}.gates.${gate.id}`) }] : []);
  // Rulesets must not hide unbound tool gates from the grader format validator.
  if (legacy) validateGrader({ ...legacy, gates: legacy.gates.map(gate => 'check' in gate ? gates.find(resolved => resolved.id === gate.id)! : gate) });
  if (atomic) gates.forEach(gate => checkBinding(gate.check, `${location}.gates.${gate.id}`));
  const artifact = (node.input as string).slice(9).split('#')[0]!;
  function assertBinding(check: CheckNode): void {
    if (check.eval && isBuiltin(check.eval) && typeof check.input === 'string' &&
      check.input.split('#')[0] !== `artifact:${artifact}`) {
      fail(location, `grader gate input must select graded artifact ${artifact}`);
    }
    if (check.eval === 'tool-sequence' && (check.ending_at as { artifact: string }).artifact !== artifact) {
      fail(location, `grader gate must end at graded artifact ${artifact}`);
    }
    for (const child of [...(check.all ?? []), ...(check.any ?? []), ...(check.not ? [check.not] : [])]) assertBinding(child);
  }
  gates.forEach(gate => assertBinding(gate.check));
  const grader_binding: GraderBinding = { definitionDigest: context.criterionFileDigests![filename]!.slice(7),
    ...(atomic ? { kind: 'atomic' as const, templatesDigest: context.criterionFileDigests![resourcePath]!.slice(7) }
      : { calibrationDigest: context.criterionFileDigests![resourcePath]!.slice(7) }), gates };
  context.versions[`grader:${filename}`] = `${grader_binding.definitionDigest}:${grader_binding.templatesDigest ?? grader_binding.calibrationDigest}`;
  return { ...structuredClone(node), grader: path.resolve(path.dirname(context.sourceName ?? 'dataset.yaml'), filename), grader_binding };
}
