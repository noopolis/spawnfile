/** Deliberately lexical: English grouped numbers, dot decimals, units and quoted spans. */
const currency: Readonly<Record<string, string>> = { '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' };
const unit = '(?:USD|EUR|GBP|JPY|[$€£¥])';
const digits = "(?:\\d{1,3}(?:[, '\\u00a0\\u202f]\\d{3})+|\\d+)(?:\\.\\d+)?";
const numeric = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${unit}\\s*)?[+−-]?${digits}(?:\\s*(?:%|${unit}))?(?![\\p{L}\\p{N}_])`, 'gu');

export function stripIgnored(text: string, patterns: readonly string[]): string {
  return patterns.reduce((value, pattern) => value.replace(new RegExp(pattern, 'gu'), ' '), text);
}
function normalizeNumber(raw: string): string {
  const units = raw.match(/USD|EUR|GBP|JPY|[$€£¥%]/g) ?? [];
  const value = raw.replace(/USD|EUR|GBP|JPY|[$€£¥%]|[, '\u00a0\u202f\s]/g, '').replace('−', '-');
  // String arithmetic preserves integers above Number.MAX_SAFE_INTEGER.
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace(/^[+-]/, '').split('.');
  const normalized = `${whole!.replace(/^0+(?=\d)/, '')}${fraction.replace(/0+$/, '') ? `.${fraction.replace(/0+$/, '')}` : ''}`;
  return `${negative && normalized !== '0' ? '-' : ''}${normalized}:${units.map(item => currency[item] ?? item).join(':')}`;
}
export function extractedNumbers(text: string): { raw: string; normalized: string }[] {
  return [...text.normalize('NFKC').matchAll(numeric)].map(match => ({ raw: match[0], normalized: normalizeNumber(match[0]) }));
}
export function quotedSpans(text: string): string[] {
  return [...text.matchAll(/"([^"\r\n]+)"|“([^”\r\n]+)”/gu)].map(match => (match[1] ?? match[2])!);
}
export function normalizeQuote(text: string): string {
  return text.normalize('NFKC').replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"').replace(/[‐‑‒–—−]/gu, '-')
    .replace(/\s+/gu, ' ').replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '');
}
