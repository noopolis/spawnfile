/** Lines a candidate adds to its baseline and lines it drops, by exact trimmed text. */
export function changedLines(baseline: string, candidate: string): { added: string[]; removed: string[] } {
  const lines = (text: string) => text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  const before = new Set(lines(baseline)), after = new Set(lines(candidate));
  return { added: [...after].filter(line => !before.has(line)), removed: [...before].filter(line => !after.has(line)) };
}

/** Distinctive word stems of a text: the first six letters of every word of five letters or more. */
export function terms(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/\p{L}{5,}/gu) ?? []).map(word => word.slice(0, 6)));
}

export interface CaseOverlap { line: string; cases: { id: string; terms: string[] }[] }

/**
 * Candidate-added lines that share distinctive terms with a train case and with nothing the candidate could
 * have taken them from otherwise (the baseline, the house guide). A deterministic hint for the critic and the
 * operator: it shows where to look, it does not decide that a line is case-specific.
 */
export function caseOverlaps(added: readonly string[], cases: readonly { id: string; text: string }[], known: readonly string[], minimum = 1): CaseOverlap[] {
  const familiar = new Set(known.flatMap(text => [...terms(text)]));
  const indexed = cases.map(entry => ({ id: entry.id, terms: terms(entry.text) }));
  return added.flatMap(line => {
    const fresh = [...terms(line)].filter(term => !familiar.has(term));
    const hits = indexed.map(entry => ({ id: entry.id, terms: fresh.filter(term => entry.terms.has(term)).sort() })).filter(hit => hit.terms.length >= minimum);
    return hits.length ? [{ line, cases: hits }] : [];
  });
}
