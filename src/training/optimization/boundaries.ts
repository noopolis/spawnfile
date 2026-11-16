/**
 * Exact text constraints, not semantic policy judgments or proposer attestations. `max-bytes` bounds a component's
 * UTF-8 size, so a proposal the subject's runtime could not load (an instruction limit) is refused before its trials.
 */
export interface TextBoundary {
  kind: 'preserve' | 'require-text' | 'forbid-text' | 'max-bytes';
  component: string;
  text: string;
}

export function compileBoundaries(declarations: string[], seed: Record<string, string>): TextBoundary[] {
  const rules = declarations.map(declaration => {
    const match = /^(preserve|require-text|forbid-text|max-bytes) (\[.*\])$/s.exec(declaration);
    let args: unknown;
    try { args = match ? JSON.parse(match[2]!) : undefined; } catch { args = undefined; }
    if (!match || match[0] !== declaration || !Array.isArray(args) || args.length !== (match[1] === 'preserve' ? 1 : 2)
        || args.some(arg => typeof arg !== 'string' || !arg.trim()) || !Object.hasOwn(seed, args[0] as string)
        || (match[1] === 'max-bytes' && !/^[1-9][0-9]{0,8}$/u.test(args[1] as string))) {
      throw new Error('Unsupported hard boundary: expected preserve [component], require-text [component, text], '
        + 'forbid-text [component, text] or max-bytes [component, "<bytes>"] with JSON string arguments and a known component');
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
        || (kind === 'require-text' && !value.includes(text)) || (kind === 'forbid-text' && value.includes(text))
        || (kind === 'max-bytes' && Buffer.byteLength(value, 'utf8') > Number(text))) {
      throw new Error(`Candidate violates hard boundary: ${kind} on ${component}`);
    }
  }
}
