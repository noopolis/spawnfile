import type { CheckNode } from '../../contracts/dataset.js';
import type { EvaluationRegistry } from '../../contracts/evaluation.js';

export function requireMechanicalTurn(checks: readonly CheckNode[], registry: EvaluationRegistry): void {
  const prior = new Set<string>();
  function mechanical(node: CheckNode): boolean {
    const operations = ['eval', 'all', 'any', 'not', 'passed', 'score'].filter(key => Object.hasOwn(node, key));
    if (operations.length !== 1) return false;
    if (node.eval) return registry[node.eval]?.definition.kind === 'mechanical';
    if (node.passed || node.score) return prior.has((node.passed ?? node.score)!);
    if (node.not) return mechanical(node.not);
    const children = node.all ?? node.any;
    return Boolean(children?.length && children.every(mechanical));
  }
  for (const check of checks) {
    if (!mechanical(check)) throw new Error('Native turn gates require self-contained mechanical criteria');
    if (check.id) prior.add(check.id);
  }
}
