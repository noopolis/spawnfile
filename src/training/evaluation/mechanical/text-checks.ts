import type { CheckNode } from '../../contracts/dataset.js';
import type { EvaluationContext, EvaluationResult, EvidenceReference } from '../../contracts/evaluation.js';
import { isTextSelector, textSelectors } from '../../cases/index.js';
import { result } from '../logic/index.js';
import { observedAbsence, selectEvidence, textReference } from '../selectors.js';
import { extractedNumbers, normalizeQuote, quotedSpans, stripIgnored } from './text-values.js';

type TextSelection = { text: string; evidence: EvidenceReference[] } | { failure: EvaluationResult };
async function selectTexts(selectors: string[], context: EvaluationContext, sources = false): Promise<TextSelection> {
  const texts: string[] = [], evidence: EvidenceReference[] = [];
  for (const selector of selectors) {
    if (sources && !isTextSelector(selector)) {
      const text = await context.readText(selector);
      texts.push(text); evidence.push(textReference('sidecar', selector, text));
      continue;
    }
    const selected = selectEvidence(selector, context.snapshot);
    if (!selected.found) {
      const missingInput = !sources && observedAbsence(selector, context.snapshot);
      return { failure: { ...result(missingInput ? 'fail' : 'unknown', `Missing ${selector}`, context.snapshot.closed),
        ...(missingInput ? { score: 0 } : {}), evidence: [...evidence, ...selected.evidence] } };
    }
    const value = selector === 'input:files' ? Object.values(selected.value as Record<string, string>) : selected.value;
    const strings = Array.isArray(value) ? value : [value];
    if (strings.some(item => typeof item !== 'string')) return { failure: result('error', `Text selector requires a string or array of strings: ${selector}`, context.snapshot.closed) };
    texts.push(...strings as string[]); evidence.push(...selected.evidence);
  }
  return { text: texts.join('\n'), evidence };
}

export async function evaluateTextCheck(check: CheckNode, context: EvaluationContext): Promise<EvaluationResult> {
  const selected = await selectTexts(textSelectors(check.input), context);
  if ('failure' in selected) return selected.failure;
  const ignore = (check.ignore ?? []) as string[];
  const input = stripIgnored(selected.text, ignore);
  if (check.eval === 'word-count') {
    const count = input.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
    const passed = count >= ((check.min as number | undefined) ?? 0) && count <= ((check.max as number | undefined) ?? Infinity);
    return { ...result(passed ? 'pass' : 'fail', `word-count: ${count}`, context.snapshot.closed), score: Number(passed),
      evidence: selected.evidence, mechanicalEvidence: { count } };
  }
  const sources = await selectTexts(textSelectors(check.source), context, true);
  if ('failure' in sources) return sources.failure;
  const source = stripIgnored(sources.text, ignore);
  const numbers = extractedNumbers(input), quotes = quotedSpans(input);
  const available = new Set(extractedNumbers(source).map(value => value.normalized));
  const missing = numbers.filter(value => !available.has(value.normalized)).map(value => value.raw);
  const normalizedSource = normalizeQuote(source);
  missing.push(...quotes.filter(value => !normalizedSource.includes(normalizeQuote(value))).map(value => `"${value}"`));
  const total = numbers.length + quotes.length, found = total - missing.length;
  return { ...result(missing.length <= ((check.max_missing as number | undefined) ?? 0) ? 'pass' : 'fail',
    `values-in-source: ${found}/${total}; missing: ${JSON.stringify(missing)}`, context.snapshot.closed),
    score: total ? found / total : 1, evidence: [...selected.evidence, ...sources.evidence],
    mechanicalEvidence: { found, total, missing } };
}
