import { Environment, type ASTNode } from '@marcbachmann/cel-js';

const environment = new Environment({ limits: { maxAstNodes: 1_000, maxDepth: 40 } });

function selector(node: ASTNode): string[] | undefined {
  if (node.op === 'id') return [node.args];
  if (node.op === '.') {
    const parent = selector(node.args[0]);
    if (parent) return [...parent, node.args[1]];
  }
  return undefined;
}

/** Only positive equality conjuncts prove binding; mentions, negations and
 * alternative Boolean branches cannot establish an artifact constraint. */
export function requiresArgumentBinding(expression: unknown, bound: Set<string>): boolean {
  if (typeof expression !== 'string' || expression.length > 16_384) return false;
  const guarantees = (node: ASTNode): boolean => {
    if (node.op === '&&') return guarantees(node.args[0]) || guarantees(node.args[1]);
    if (node.op !== '==') return false;
    const left = selector(node.args[0]);
    const right = selector(node.args[1]);
    const matches = (argument: string[] | undefined, binding: string[] | undefined) => !!argument && !!binding && argument.length > 2 &&
      argument[0] === 'call' && argument[1] === 'args' &&
      binding.length === 2 && binding[0] === 'bindings' && bound.has(binding[1]!);
    return matches(left, right) || matches(right, left);
  };
  try { return guarantees(environment.parse(expression).ast); }
  catch { return false; }
}
