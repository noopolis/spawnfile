interface Group { quantified: boolean }

/** Enforce the prescribed syntax restrictions; these alone do not bound engine runtime. */
export function rowRegexSafetyIssue(source: string): string | undefined {
  const groups: Group[] = [{ quantified: false }];
  let atomQuantified = false;
  for (let index = 0; index < source.length; index++) {
    const token = source[index]!;
    if (token === '\\') {
      const escaped = source[++index]!;
      if (/[1-9]/u.test(escaped) || (escaped === 'k' && source[index + 1] === '<')) {
        return 'row regex subset forbids backreferences';
      }
      atomQuantified = false;
    } else if (token === '[') {
      while (++index < source.length && source[index] !== ']') {
        if (source[index] === '\\') index++;
      }
      atomQuantified = false;
    } else if (token === '(') {
      if (source[index + 1] === '?') {
        if (source[index + 2] === ':') index += 2;
        else if (source[index + 2] === '<' && !['=', '!'].includes(source[index + 3]!)) {
          index = source.indexOf('>', index + 3);
        } else return 'row regex subset forbids lookaround';
      }
      groups.push({ quantified: false });
      atomQuantified = false;
    } else if (token === ')') {
      atomQuantified = groups.pop()!.quantified;
      groups.at(-1)!.quantified ||= atomQuantified;
    } else {
      const counted = token === '{' ? /^\{\d+(?:,\d*)?\}/u.exec(source.slice(index)) : null;
      if (token === '*' || token === '+' || token === '?' || counted) {
        if (atomQuantified) return 'row regex subset requires star height <= 1 (no nested quantifiers)';
        groups.at(-1)!.quantified = true;
        atomQuantified = true;
        if (counted) index += counted[0].length - 1;
        if (source[index + 1] === '?') index++; // Lazy suffix is not another repetition.
      } else atomQuantified = false;
    }
  }
  return undefined;
}
