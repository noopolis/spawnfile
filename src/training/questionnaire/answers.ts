import type { AnswerRecord, BankQuestion, CombineMode, QuestionBank, QuestionnaireScore } from './types.js';
import { bankQuestions } from './bank.js';

type Parsed = { status: 'ok'; value: unknown } | { status: 'na' };

/** Returns the typed answer, or the reason the declared type does not allow it. Nothing is coerced into a pass. */
export function parseAnswer(question: BankQuestion, raw: unknown): Parsed | { status: 'error'; error: string } {
  const refuse = (error: string) => ({ status: 'error' as const, error });
  if (raw === null || raw === undefined) return refuse('missing answer');
  if (question.type === 'extraction-list') {
    return Array.isArray(raw) && raw.every(item => typeof item === 'string') ? { status: 'ok', value: raw }
      : refuse('extraction-list answer must be a list of strings');
  }
  if (question.type === 'free-text') {
    return typeof raw === 'string' && raw.trim() ? { status: 'ok', value: raw.trim() } : refuse('free-text answer is empty or not text');
  }
  if (typeof raw !== 'string' && (typeof raw !== 'number' || !Number.isFinite(raw))) return refuse(`answer ${JSON.stringify(raw)} is not allowed`);
  const answer = String(raw).trim().toLowerCase();
  if (answer === '') return refuse('missing answer');
  if (answer === 'na') return question.na_when ? { status: 'na' } : refuse('na is not allowed for this question');
  if (question.type === 'yes-no') return answer === 'yes' || answer === 'no' ? { status: 'ok', value: answer } : refuse(`answer ${JSON.stringify(raw)} is not yes or no`);
  if (question.type === 'multiple-choice') {
    const option = question.options!.find(entry => entry.id.toLowerCase() === answer);
    return option ? { status: 'ok', value: option.id } : refuse(`answer ${JSON.stringify(raw)} is not one of the options`);
  }
  return /^-?\d+(\.\d+)?$/u.test(answer) ? { status: 'ok', value: Number(answer) } : refuse(`answer ${JSON.stringify(raw)} is not a number`);
}

export function scoreAnswer(question: BankQuestion, value: unknown): number {
  if (question.type === 'yes-no') return value === question.pass ? 1 : 0;
  if (question.type === 'multiple-choice') return question.options!.find(option => option.id === value)!.score;
  const number = value as number;
  if (question.pass_when) return (question.pass_when.min ?? -Infinity) <= number && number <= (question.pass_when.max ?? Infinity) ? 1 : 0;
  return question.bands!.find(band => number <= band.max)?.score ?? 0;
}

/** One judge reply for one question. An answer the type does not allow is an error: it scores 0 and never passes. */
export function judgeAnswer(question: BankQuestion, raw: unknown, reason: unknown = ''): AnswerRecord {
  const base = { id: question.id, type: question.type, reason: typeof reason === 'string' ? reason : '' };
  const parsed = parseAnswer(question, raw);
  const scored = question.role === 'scored';
  if (parsed.status === 'error') {
    return { ...base, status: 'error', answer: raw ?? null, score: scored ? 0 : null, passed: scored ? false : null, error: parsed.error };
  }
  if (parsed.status === 'na') return { ...base, status: 'na', answer: 'na', score: null, passed: null };
  if (!scored) return { ...base, status: 'ok', answer: parsed.value, score: null, passed: null };
  const score = scoreAnswer(question, parsed.value);
  return { ...base, status: 'ok', answer: parsed.value, score, passed: score >= question.pass_min };
}

/** Folds the repeats of one scored question into one record. An error counts as a vote and outranks every score. */
export function combineAnswers(question: BankQuestion, records: readonly AnswerRecord[], mode: CombineMode): AnswerRecord {
  if (records.length === 1) return records[0]!;
  const votes = records.map(record => record.status === 'error' ? 'error' : record.answer);
  const rank = (record: AnswerRecord) => record.status === 'error' ? -1 : record.score ?? 2;
  const worst = (pool: readonly AnswerRecord[]) => pool.reduce((low, record) => rank(record) < rank(low) ? record : low);
  const ok = records.filter(record => record.status === 'ok');
  const errors = records.filter(record => record.status === 'error');
  let pick: AnswerRecord;
  if (mode === 'any-fail') pick = worst(records);
  else if (mode === 'all-fail') pick = ok.length ? ok.reduce((high, record) => record.score! > high.score! ? record : high) : worst(records);
  else if (mode === 'mean') {
    if (errors.length) pick = errors[0]!;
    else if (!ok.length) pick = records[0]!;
    else {
      const mean = ok.reduce((sum, record) => sum + record.score!, 0) / ok.length;
      pick = { ...worst(ok), score: Math.round(mean * 10_000) / 10_000, passed: mean >= question.pass_min };
    }
  } else if (question.type === 'number' && ok.length > records.length / 2) {
    const sorted = ok.map(record => record.answer as number).sort((a, b) => a - b);
    const median = sorted[Math.floor((sorted.length - 1) / 2)]!;
    pick = ok.find(record => record.answer === median)!;
  } else {
    // Majority: a tie goes to the lower score.
    const count = (vote: unknown) => votes.filter(other => other === vote).length;
    const top = Math.max(...votes.map(count));
    pick = worst(records.filter((_, index) => count(votes[index]) === top));
  }
  return { ...pick, votes };
}

/**
 * The score of one graded output: a weighted mean over scored questions that are not `na`, the same over
 * hidden and open questions alone, and the gate. A gate question that errored makes the gate `error`, never `pass`.
 */
export function scoreQuestionnaire(bank: QuestionBank, records: Readonly<Record<string, AnswerRecord>>): QuestionnaireScore {
  const questions = bankQuestions(bank, 'scored');
  const missing = questions.filter(question => !Object.hasOwn(records, question.id)).map(question => question.id);
  if (missing.length) throw new Error(`No record for: ${missing.join(', ')}`);
  const mean = (select: (question: BankQuestion) => boolean): number | null => {
    const rows = questions.filter(question => select(question) && records[question.id]!.status !== 'na');
    const weight = rows.reduce((sum, question) => sum + question.weight, 0);
    return weight ? Math.round(rows.reduce((sum, question) => sum + question.weight * records[question.id]!.score!, 0) / weight * 10_000) / 10_000 : null;
  };
  const gates = questions.filter(question => question.gate).map(question => records[question.id]!);
  const gateFailures = gates.filter(record => record.status === 'ok' && !record.passed).map(record => record.id);
  return {
    gate: gateFailures.length ? 'fail' : gates.some(record => record.status === 'error') ? 'error' : 'pass',
    gateFailures, errors: questions.filter(question => records[question.id]!.status === 'error').map(question => question.id),
    score: mean(() => true), scoreHidden: mean(question => question.hidden), scoreOpen: mean(question => !question.hidden),
  };
}
