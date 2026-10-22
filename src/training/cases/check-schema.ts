import { exclusive, fail, fields, number, object, sequence, string } from './validation.js';

const operations = ['eval', 'all', 'any', 'not', 'passed', 'score', 'use'];
export function checkShape(value: unknown, path: string, identified = false, depth = 0): void {
  if (depth > 48) fail(path, 'check nesting exceeds 48 levels');
  const node = object(value, path);
  if (identified || node.id !== undefined) string(node.id, `${path}.id`);
  exclusive(node, operations, path, true);
  if (node.eval !== undefined) {
    string(node.eval, `${path}.eval`);
    return; // Registered evaluators own their parameter schema.
  }
  const op = operations.find(key => node[key] !== undefined)!;
  const allowed = op === 'score' ? ['at_least'] : op === 'use' ? ['with'] : [];
  fields(node, ['id', op, ...allowed], path);
  if (op === 'all' || op === 'any') {
    sequence(node[op], `${path}.${op}`).forEach((child, index) => checkShape(child, `${path}.${op}[${index}]`, false, depth + 1));
  } else if (op === 'not') {
    checkShape(node.not, `${path}.not`, false, depth + 1);
  } else {
    string(node[op], `${path}.${op}`);
    if (op === 'score') number(node.at_least, `${path}.at_least`);
    if (op === 'use' && node.with !== undefined) object(node.with, `${path}.with`);
  }
}
export function planShape(value: Record<string, unknown>, path: string): void {
  exclusive(value, ['checks', 'stages'], path);
  if (value.checks !== undefined) {
    sequence(value.checks, `${path}.checks`).forEach((check, index) => checkShape(check, `${path}.checks[${index}]`, true));
  }
  if (value.stages === undefined) return;
  sequence(value.stages, `${path}.stages`).forEach((value, index) => {
    const stagePath = `${path}.stages[${index}]`;
    const stage = object(value, stagePath);
    fields(stage, ['id', 'when', 'checks', 'score', 'gate'], stagePath);
    string(stage.id, `${stagePath}.id`);
    sequence(stage.checks, `${stagePath}.checks`).forEach((check, checkIndex) => checkShape(check, `${stagePath}.checks[${checkIndex}]`, true));
    if (stage.when !== undefined) checkShape(stage.when, `${stagePath}.when`);
    if (stage.gate !== undefined) checkShape(stage.gate, `${stagePath}.gate`);
    if (stage.score !== undefined) {
      const score = object(stage.score, `${stagePath}.score`);
      fields(score, ['linear'], `${stagePath}.score`);
      const weights = object(score.linear, `${stagePath}.score.linear`);
      const values = Object.entries(weights).map(([key, weight]) => number(weight, `${stagePath}.score.linear.${key}`, 0, Number.MAX_VALUE));
      const total = values.reduce((sum, weight) => sum + weight, 0);
      if (!Number.isFinite(total) || total <= 0) {
        fail(`${stagePath}.score.linear`, 'weights must have a finite positive total');
      }
    }
  });
}
