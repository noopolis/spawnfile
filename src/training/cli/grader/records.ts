import type { DecisionRequest, DecisionResult } from '../../contracts/grading.js';
import { allQuestions, deriveConsensus, expandInstances, expectedOptions, optionsFor,
  type Grader, type Labels, type Label, type QuestionInstance, type DecisionQuestion,
  type Consensus, type CalibrationRecord, type CascadeRecord } from '../../graders/index.js';

export interface GoldenInstance {
  label: Label;
  instance: QuestionInstance;
  question: DecisionQuestion;
  golden: Consensus;
  request: DecisionRequest;
}

export function independentConsensus(label: Label, labelers: Labels['labelers'], teacher: string, keys: string[]) {
  const remaining = Object.fromEntries(Object.entries(labelers).filter(([id]) => id !== teacher));
  return deriveConsensus({ ...label, asked: label.asked?.filter(id => id !== teacher),
    votes: Object.fromEntries(Object.entries(label.votes).map(([key, votes]) =>
      [key, Object.fromEntries(Object.entries(votes).filter(([id]) => id !== teacher))])) }, remaining, keys);
}

export function goldenInstances(grader: Grader, labels: Labels): { rows: GoldenInstance[]; disputed: number; unavailable: number } {
  const questions = new Map(allQuestions(grader).map(question => [question.id, question]));
  const rows: GoldenInstance[] = [];
  let disputed = 0, unavailable = 0;
  for (const label of labels.labels) {
    const instances = expandInstances(grader, label.output, label.context);
    const keys = instances.map(instance => instance.key);
    const consensus = grader.model.backend === 'teacher'
      ? independentConsensus(label, labels.labelers, grader.model.teacher, keys)
      : deriveConsensus(label, labels.labelers, keys);
    for (const instance of instances) {
      if (instance.state !== 'ready') { if (instance.state === 'missing') unavailable++; continue; }
      const golden = consensus[instance.key]!;
      if (golden.disputed) { disputed++; continue; }
      const question = questions.get(instance.questionId)!;
      rows.push({ label, instance, golden, question, request: {
        key: `${label.id}:${instance.key}`, type: question.type,
        optionLabels: optionsFor(question), expectedOptions: expectedOptions(question),
        instructions: question.ask ?? question.id, projection: instance.projection,
      } });
    }
  }
  return { rows, disputed, unavailable };
}

export function rawGood(row: GoldenInstance, result: DecisionResult): number | undefined {
  if (result.status !== 'ok' || result.probabilities === null) return undefined;
  const values = row.request.optionLabels.map(option => result.probabilities![String(option)]);
  if (values.some(value => !Number.isFinite(value) || value! < 0 || value! > 1) ||
    Math.abs(values.reduce<number>((sum, value) => sum + value!, 0) - 1) > 1e-5) throw new Error('Backend returned invalid option probabilities');
  return expectedOptions(row.question).reduce<number>((sum, option) => sum + result.probabilities![String(option)]!, 0);
}

export function calibrationRecord(row: GoldenInstance, rawPGood: number): CalibrationRecord {
  return { questionId: row.question.id, type: row.question.type, group: row.label.lineage,
    example: row.label.example, source: row.golden.source,
    rawPGood, good: expectedOptions(row.question).includes(row.golden.answer!) };
}

export function cascadeRecord(row: GoldenInstance, record: CalibrationRecord, p: number, labelers: Labels['labelers']): CascadeRecord {
  return { ...record, p, outputId: row.label.id, projectionDigest: row.instance.projectionDigest,
    votes: row.label.votes[row.instance.key] ?? {}, asked: [...new Set([...(row.label.asked ?? []), ...Object.values(row.label.votes).flatMap(votes => Object.keys(votes))])], labelers,
    expected: expectedOptions(row.question), goldenLabelers: Object.keys(row.golden.votes) };
}
