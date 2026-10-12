/** Exact text constraints, not semantic policy judgments or proposer attestations. */
export interface TextBoundary {
  kind: 'preserve' | 'require-text' | 'forbid-text';
  component: string;
  text: string;
}

export function compileBoundaries(declarations: string[], seed: Record<string, string>): TextBoundary[] {
  const rules = declarations.map(declaration => {
    const match = /^(preserve|require-text|forbid-text) (\[.*\])$/s.exec(declaration);
    let args: unknown;
    try { args = match ? JSON.parse(match[2]!) : undefined; } catch { args = undefined; }
    if (!match || match[0] !== declaration || !Array.isArray(args) || args.length !== (match[1] === 'preserve' ? 1 : 2)
        || args.some(arg => typeof arg !== 'string' || !arg.trim()) || !Object.hasOwn(seed, args[0] as string)) {
      throw new Error('Unsupported hard boundary: expected preserve [component], require-text [component, text], '
        + 'or forbid-text [component, text] with JSON string arguments and a known component');
    }
    const kind = match[1] as TextBoundary['kind'], component = args[0] as string;
    return { kind, component, text: kind === 'preserve' ? seed[component]! : args[1] as string };
  });
  assertBoundaries(rules, seed);
  return rules;
}

export function assertBoundaries(rules: TextBoundary[], components: Record<string, string>): void {
  for (const { kind, component, text } of rules) {
    const value = Object.hasOwn(components, component) ? components[component] : undefined;
    if (typeof value !== 'string' || (kind === 'preserve' && value !== text)
        || (kind === 'require-text' && !value.includes(text)) || (kind === 'forbid-text' && value.includes(text))) {
      throw new Error(`Candidate violates hard boundary: ${kind} on ${component}`);
    }
  }
}
