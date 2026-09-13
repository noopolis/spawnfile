import type { EvaluatorDefinition } from '../contracts/dataset.js';
import { validatePredicate } from './turn-bindings.js';
import { exclusive, fail, fields, number, object, oneOf, safePath, sequence, string, uniqueStrings } from './validation.js';

function descriptor(kind: EvaluatorDefinition['kind'], allowed: string[], required: string[],
  validate?: EvaluatorDefinition['validate']): EvaluatorDefinition {
  return {
    // Proof capability permits runtime finality assessment, not premature failure.
    // Repairable checks remain provisional; negated presence can fail decisively.
    version: '1', kind, incremental: true, stopProof: kind === 'mechanical',
    validate(parameters, path) {
      fields(parameters, allowed, path);
      for (const name of required) if (parameters[name] === undefined) fail(`${path}.${name}`, 'required field');
      validate?.(parameters, path);
    },
  };
}
function textParameters(parameters: Readonly<Record<string, unknown>>, path: string): void {
  string(parameters.input, `${path}.input`);
}
function toolParameters(parameters: Readonly<Record<string, unknown>>, path: string): void {
  string(parameters.tool, `${path}.tool`);
  if (parameters.outcome !== undefined) oneOf(parameters.outcome, ['succeeded', 'failed'], `${path}.outcome`);
  if (parameters.phase !== undefined) oneOf(parameters.phase, ['dispatch', 'completion'], `${path}.phase`);
}
function sequenceParameters(parameters: Readonly<Record<string, unknown>>, path: string): void {
  oneOf(parameters.order, ['happens-before'], `${path}.order`);
  if (parameters.ending_at !== undefined) {
    const ending = object(parameters.ending_at, `${path}.ending_at`);
    fields(ending, ['artifact', 'event'], `${path}.ending_at`);
    string(ending.artifact, `${path}.ending_at.artifact`);
    oneOf(ending.event, ['accepted-call'], `${path}.ending_at.event`);
  }
  const bindings = new Set<string>();
  sequence(parameters.steps, `${path}.steps`).forEach((value, index) => {
    const stepPath = `${path}.steps[${index}]`;
    const step = object(value, stepPath);
    fields(step, ['tool', 'where', 'bind'], stepPath);
    string(step.tool, `${stepPath}.tool`);
    if (step.where !== undefined) {
      const where = object(step.where, `${stepPath}.where`);
      fields(where, ['cel'], `${stepPath}.where`);
      validatePredicate(where.cel, ['call', 'context', 'bindings'], `${stepPath}.where.cel`);
    }
    if (step.bind !== undefined) {
      const bind = object(step.bind, `${stepPath}.bind`);
      for (const [name, selector] of Object.entries(bind)) {
        if (bindings.has(name)) fail(stepPath, `duplicate sequence binding ${name}`);
        if (!/^call\.(args|result)(\.[A-Za-z_][\w-]*)*$/.test(string(selector, `${stepPath}.bind.${name}`))) {
          fail(stepPath, 'bindings must select call.args or call.result fields');
        }
        bindings.add(name);
      }
    }
  });
}
export const builtinEvaluatorDefinitions: Readonly<Record<string, EvaluatorDefinition>> = {
  equals: descriptor('mechanical', ['input', 'value'], ['input', 'value'], textParameters),
  'contains-any': descriptor('mechanical', ['input', 'values'], ['input', 'values'], (parameters, path) => {
    textParameters(parameters, path);
    uniqueStrings(parameters.values, `${path}.values`);
  }),
  'json-schema': descriptor('mechanical', ['input', 'schema'], ['input', 'schema'], (parameters, path) => {
    textParameters(parameters, path);
    if (typeof parameters.schema === 'string') safePath(parameters.schema, `${path}.schema`);
    else object(parameters.schema, `${path}.schema`);
  }),
  'tool-called': descriptor('mechanical', ['tool', 'outcome', 'phase'], ['tool'], toolParameters),
  'tool-count': descriptor('mechanical', ['tool', 'outcome', 'phase', 'exactly', 'at_least', 'at_most'], ['tool'], (parameters, path) => {
    toolParameters(parameters, path);
    if (!['exactly', 'at_least', 'at_most'].some(key => parameters[key] !== undefined)) fail(path, 'count requires a bound');
    if (parameters.exactly !== undefined && (parameters.at_least !== undefined || parameters.at_most !== undefined)) fail(path, 'exactly cannot combine with other bounds');
    for (const key of ['exactly', 'at_least', 'at_most']) {
      if (parameters[key] !== undefined && !Number.isSafeInteger(number(parameters[key], `${path}.${key}`, 0, Number.MAX_SAFE_INTEGER))) fail(path, 'count must be an integer');
    }
    if (typeof parameters.at_least === 'number' && typeof parameters.at_most === 'number' && parameters.at_least > parameters.at_most) fail(path, 'inverted count bounds');
  }),
  'tool-sequence': descriptor('mechanical', ['order', 'steps', 'ending_at'], ['order', 'steps'], sequenceParameters),
  'llm-rubric': descriptor('semantic', ['input', 'evidence', 'judge', 'rubric', 'minimum'], ['input', 'judge', 'rubric', 'minimum'], (parameters, path) => {
    textParameters(parameters, path);
    if (parameters.evidence !== undefined) string(parameters.evidence, `${path}.evidence`);
    string(parameters.judge, `${path}.judge`);
    number(parameters.minimum, `${path}.minimum`);
    const rubric = object(parameters.rubric, `${path}.rubric`);
    fields(rubric, ['prompt', 'file'], `${path}.rubric`);
    exclusive(rubric, ['prompt', 'file'], `${path}.rubric`, true);
    if (rubric.prompt !== undefined) string(rubric.prompt, `${path}.rubric.prompt`);
    if (rubric.file !== undefined) safePath(rubric.file, `${path}.rubric.file`);
  }),
  'embedding-similarity': descriptor('embedding', ['input', 'reference', 'provider', 'model', 'metric', 'calibration', 'minimum'],
    ['input', 'reference', 'provider', 'model', 'metric', 'calibration', 'minimum'], (parameters, path) => {
      for (const key of ['input', 'reference', 'provider', 'model', 'calibration']) string(parameters[key], `${path}.${key}`);
      oneOf(parameters.metric, ['cosine'], `${path}.metric`);
      number(parameters.minimum, `${path}.minimum`, -1, 1);
    }),
};
