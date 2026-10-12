/** One paragraph at a time; never create empty units from citation-only tails. */
export function moveLeadingCitations(sentences: string[], patterns: string[]): string[] {
  const citations = patterns.map(pattern => new RegExp(pattern, 'my'));
  const result: string[] = [];
  for (const sentence of sentences) {
    let end = 0;
    if (result.length) {
      let start = 0;
      while (start < sentence.length) {
        let length = 0;
        for (const citation of citations) {
          citation.lastIndex = start;
          length = Math.max(length, citation.exec(sentence)?.[0].length ?? 0);
        }
        // Zero-width matches are not tokens and must not prevent termination.
        if (!length) break;
        end = start + length;
        start = end + /^\s*/u.exec(sentence.slice(end))![0].length;
      }
    }
    if (end) result[result.length - 1] += ` ${sentence.slice(0, end)}`;
    const remaining = sentence.slice(end).trim();
    if (remaining) result.push(remaining);
  }
  return result;
}

