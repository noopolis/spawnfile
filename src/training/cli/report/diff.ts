/** One context hunk, linear memory even for a whole-file rewrite. */
export function unifiedDiff(path: string, before: string, after: string): string {
  if (before === after) return '';
  const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const left = lines(before), right = lines(after);
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(left.length, right.length) && left[prefix] === right[prefix]) prefix++;
  while (suffix < Math.min(left.length, right.length) - prefix && left.at(-1 - suffix) === right.at(-1 - suffix)) suffix++;
  const start = Math.max(0, prefix - 3);
  const leftEnd = Math.min(left.length, left.length - suffix + 3);
  const rightEnd = Math.min(right.length, right.length - suffix + 3);
  const range = (length: number) => `${length === 0 ? start : start + 1},${length}`;
  const name = (side: string) => JSON.stringify(`${side}/${path}`);
  const emit = (mark: string, line: string) => `${mark}${line}${line.endsWith('\n') ? '' : '\n\\ No newline at end of file\n'}`;
  return `--- ${name('a')}\n+++ ${name('b')}\n@@ -${range(leftEnd - start)} +${range(rightEnd - start)} @@\n`
    + left.slice(start, prefix).map(line => emit(' ', line)).join('')
    + left.slice(prefix, left.length - suffix).map(line => emit('-', line)).join('')
    + right.slice(prefix, right.length - suffix).map(line => emit('+', line)).join('')
    + left.slice(left.length - suffix, leftEnd).map(line => emit(' ', line)).join('');
}
