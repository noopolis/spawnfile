import { isDeepStrictEqual } from 'node:util';
import { allQuestions, stableDigest, questionDefinitionDigest, sentenceCitationPolicy } from './format/index.js';
import { citedRows, moveLeadingCitations } from './rows.js';
import type { Grader, DecisionQuestion } from './format/index.js';

export interface QuestionInstance {
  key: string;
  questionId: string;
  level: DecisionQuestion['level'];
  unit: { paragraph?: number; sentence?: number; text?: string };
  definitionDigest: string;
  projection: Record<string, unknown>;
  projectionDigest: string;
  state: 'ready' | 'missing' | 'not-applicable';
  reasons: string[];
  dependsOn?: string;
}

interface Unit { suffix: string; paragraph?: number; sentence?: string; sentenceIndex?: number; text?: string; invalid?: string }
interface Resolution { value?: unknown; missing?: string; notApplicable?: boolean }

/** ICU changes can alter sentence boundaries and therefore invalidate calibration. */
export function segmenterIdentity(): string {
  return `Intl.Segmenter:en:sentence:icu=${process.versions.icu}`;
}

function ownPath(value: unknown, path: string[]): Resolution {
  let current = value;
  for (const part of path) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, part)) {
      return { missing: `missing path ${path.join('.')}` };
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current === undefined ? { missing: `missing path ${path.join('.')}` } : { value: current };
}

function units(question: DecisionQuestion, output: unknown, grader: Grader): Unit[] {
  if (question.level === 'article') return [{ suffix: '' }];
  const body = ownPath(output, ['body']).value;
  if (!Array.isArray(body) || body.length === 0) return [{ suffix: '', invalid: 'output.body has no units' }];
  const result: Unit[] = [];
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  body.forEach((paragraph: unknown, index) => {
    if (typeof paragraph !== 'string') {
      result.push({ suffix: `@p${index}${question.level === 'sentence' ? '.s0' : ''}`,
        paragraph: index, invalid: `output.body.${index} is not a paragraph string` });
    } else if (question.level === 'paragraph') {
      result.push({ suffix: `@p${index}`, paragraph: index, text: paragraph });
    } else {
      const sentences = moveLeadingCitations(
        Array.from(segmenter.segment(paragraph), item => item.segment.trim()).filter(Boolean),
        sentenceCitationPolicy(grader).patterns,
      );
      sentences.forEach((sentence, sentenceIndex) => result.push({
        suffix: `@p${index}.s${sentenceIndex}`, paragraph: index, sentence, sentenceIndex, text: sentence,
      }));
    }
  });
  return result.length ? result : [{ suffix: '', invalid: 'output.body has no sentence units' }];
}

function resolveRead(read: string, output: unknown, context: Record<string, unknown>, unit: Unit, grader: Grader): Resolution {
  if (read.startsWith('output.')) return ownPath(output, read.slice(7).split('.'));
  if (read.startsWith('context.')) {
    if (read.endsWith('@cited')) {
      const name = read.slice(8, -6);
      const source = ownPath(context, [name]);
      if (source.missing) return source;
      return citedRows(source.value, unit.text!, grader.context[name]!.rows!);
    }
    return ownPath(context, [read.slice(8)]);
  }
  if (read === 'sentence') return { value: unit.sentence };
  const body = ownPath(output, ['body']).value;
  if (!Array.isArray(body) || unit.paragraph === undefined) return { missing: `unbound ${read}` };
  const offset = read === 'previous-paragraph' ? -1 : read === 'next-paragraph' ? 1 : 0;
  // A boundary neighbor is an observed absence, not an unobserved input.
  const value: unknown = body[unit.paragraph + offset] ?? null;
  return { value };
}

function expandQuestion(question: DecisionQuestion, output: unknown, context: Record<string, unknown>, grader: Grader): QuestionInstance[] {
  return units(question, output, grader).map(unit => {
    const projection: Record<string, unknown> = {};
    const reasons: string[] = unit.invalid ? [unit.invalid] : [];
    let state: QuestionInstance['state'] = unit.invalid ? 'missing' : 'ready';
    if (state === 'ready' && typeof question.when === 'object') {
      const predicate = question.when;
      const field = resolveRead(predicate.field, output, context, unit, grader);
      if (field.missing) reasons.push(`${predicate.field}: ${field.missing}`);
      else if (field.notApplicable) state = 'not-applicable';
      else {
        const applies = 'equals' in predicate ? isDeepStrictEqual(field.value, predicate.equals)
          : predicate.in?.some(value => isDeepStrictEqual(field.value, value));
        if (!applies) state = 'not-applicable';
      }
    }
    if (state === 'ready') {
      let hasCitedRead = false;
      let hasCitations = false;
      for (const read of question.reads) {
        const resolution = resolveRead(read, output, context, unit, grader);
        if (resolution.missing) reasons.push(`${read}: ${resolution.missing}`);
        else {
          projection[read] = resolution.value;
          if (read.endsWith('@cited')) {
            hasCitedRead = true;
            if (!resolution.notApplicable) hasCitations = true;
          }
        }
      }
      if (hasCitedRead && !hasCitations) state = 'not-applicable';
    }
    if (reasons.length) state = 'missing';
    return {
      key: `${question.id}${unit.suffix}`, questionId: question.id, level: question.level,
      unit: { ...(unit.paragraph === undefined ? {} : { paragraph: unit.paragraph }),
        ...(unit.sentenceIndex === undefined ? {} : { sentence: unit.sentenceIndex }),
        ...(unit.text === undefined ? {} : { text: unit.text }) },
      definitionDigest: questionDefinitionDigest(grader, question),
      projection, projectionDigest: stableDigest(projection), state, reasons,
      ...(typeof question.when === 'string' ? { dependsOn: `${question.id}.applies${unit.suffix}` } : {}),
    };
  });
}

/** Only declared reads enter projections; applicability predicates never leak extra fields. */
export function expandInstances(grader: Grader, output: unknown, context: Record<string, unknown> = {}): QuestionInstance[] {
  return allQuestions(grader).flatMap(question => expandQuestion(question, output, context, grader));
}
