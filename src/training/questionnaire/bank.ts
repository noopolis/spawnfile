import { parseDocument } from 'yaml';
import { z } from 'zod';
import { QUESTIONNAIRE_SCHEMA, combineModes, scaffoldTypes, scoredTypes,
  type BankQuestion, type BankRead, type QuestionBank } from './types.js';

const name = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/u, 'expected a plain identifier');
const text = z.string().min(1);
const unit = z.number().min(0).max(1);
const selector = z.string().regex(/^(output(\.[A-Za-z0-9_-]+)*|context\.[A-Za-z_][\w-]*)$/u, 'expected output, output.<field> or context.<name>');
const read = z.union([selector, z.strictObject({ from: selector, title: text.optional(), list: z.string().regex(/^[A-Z][A-Za-z]{0,7}$/u).optional(),
  template: text.optional(), distinct_from: selector.optional(), by: z.array(text).min(1).optional() })]);
const question = z.strictObject({
  id: name, type: z.enum([...scoredTypes, ...scaffoldTypes]), role: z.enum(['scored', 'scaffold']).optional(), ask: text,
  yes_when: text.optional(), no_when: text.optional(), pass: z.enum(['yes', 'no']).optional(),
  options: z.array(z.strictObject({ id: z.union([name, z.number().int()]), when: text, score: unit })).min(2).optional(),
  pass_when: z.strictObject({ min: z.number().finite().optional(), max: z.number().finite().optional() }).optional(),
  bands: z.array(z.strictObject({ max: z.number().finite(), score: unit })).min(1).optional(),
  pass_min: z.number().gt(0).max(1).optional(), weight: z.number().positive().finite().optional(),
  gate: z.boolean().optional(), hidden: z.boolean().optional(), na_when: text.optional(), rule: text.optional(),
  penalty: z.number().min(0).lt(1).optional(),
});
const controls = { judge: name.optional(), effort: name.optional(), repeats: z.number().int().min(1).max(8).optional(), combine: z.enum(combineModes).optional() };
const bank = z.strictObject({
  schema: z.literal(QUESTIONNAIRE_SCHEMA), id: text, version: z.union([z.number(), text]).optional(), instructions: text,
  penalty: z.number().min(0).lt(1).optional(), reads: z.array(read).min(1), defaults: z.strictObject(controls).optional(),
  groups: z.array(z.strictObject({ id: name, ...controls, order: z.literal('declared').optional(),
    after: z.array(name).optional(), receives: z.array(z.string().regex(/^[A-Za-z][\w-]*\.[A-Za-z][\w-]*$/u)).optional(),
    reads: z.array(read).min(1).optional(), questions: z.array(question).min(1) })).min(1),
});

/** The rung factor of a gate question in a laddered bank that declares none: one failed gate halves the search score. */
export const DEFAULT_PENALTY = 0.5;

export class BankError extends Error {
  constructor(message: string) { super(message); this.name = 'BankError'; }
}
function need(condition: unknown, message: string): asserts condition {
  if (!condition) throw new BankError(message);
}

const normalizeRead = (value: z.infer<typeof read>): BankRead => {
  const entry = typeof value === 'string' ? { from: value } : value;
  need((entry.distinct_from === undefined) === (entry.by === undefined), `read ${entry.from}: distinct_from and by go together`);
  need(entry.list !== undefined || (entry.template === undefined && entry.distinct_from === undefined), `read ${entry.from}: template and distinct_from need list`);
  return { ...entry, title: entry.title ?? entry.from.replace(/^(output|context)\./u, '').replace(/[._-]+/gu, ' ').toUpperCase() };
};

function normalizeQuestion(raw: z.infer<typeof question>): BankQuestion {
  const { id, type } = raw;
  const scored = (scoredTypes as readonly string[]).includes(type);
  const role = raw.role ?? (scored ? 'scored' : 'scaffold');
  need((role === 'scored') === scored, `${id}: type ${type} cannot have role ${role}`);
  if (!scored) {
    const extra = Object.keys(raw).filter(key => !['id', 'type', 'role', 'ask'].includes(key));
    need(extra.length === 0, `${id}: a scaffold step takes only id, type, role, ask`);
    return { id, type, role, ask: raw.ask, pass_min: 0.5, weight: 0, gate: false, hidden: false };
  }
  need(raw.rule, `${id}: rule is required for a scored question`);
  need((type === 'yes-no') === (raw.yes_when !== undefined) && (type === 'yes-no') === (raw.no_when !== undefined) && (type === 'yes-no') === (raw.pass !== undefined),
    `${id}: yes_when, no_when and pass belong to yes-no questions, which require all three`);
  need((type === 'multiple-choice') === (raw.options !== undefined), `${id}: options belong to multiple-choice questions, which require them`);
  const options = raw.options?.map(option => ({ ...option, id: String(option.id) }));
  if (options) {
    const ids = options.map(option => option.id.toLowerCase());
    need(new Set(ids).size === ids.length && !ids.includes('na'), `${id}: option ids must be unique and not na`);
  }
  if (type === 'number') {
    need((raw.pass_when !== undefined) !== (raw.bands !== undefined), `${id}: a number question needs exactly one of pass_when or bands`);
    need(!raw.pass_when || Object.keys(raw.pass_when).length > 0, `${id}: pass_when takes min and max`);
    need(!raw.bands || raw.bands.every((band, index) => index === 0 || band.max > raw.bands![index - 1]!.max), `${id}: bands must be in rising order of max`);
  } else need(raw.pass_when === undefined && raw.bands === undefined, `${id}: pass_when and bands belong to number questions`);
  need(raw.penalty === undefined || raw.gate === true, `${id}: penalty belongs to gate questions`);
  const { options: _options, ...rest } = raw;
  return { ...rest, ...(options ? { options } : {}), role, pass_min: raw.pass_min ?? 0.5, weight: raw.weight ?? 1,
    gate: raw.gate ?? false, hidden: raw.hidden ?? false };
}

/** Validates an authored bank and fills its defaults. Throws `BankError` on anything undeclared or inconsistent. */
export function validateBank(value: unknown): QuestionBank {
  const parsed = bank.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new BankError(`$.${issue.path.join('.')}: ${issue.message}`);
  }
  const raw = parsed.data;
  const defaults = { judge: 'strong', repeats: 1, combine: 'majority' as const, ...raw.defaults };
  const groupOf = new Map<string, string>();
  const scaffold = new Set<string>();
  const groups: QuestionBank['groups'] = [];
  for (const group of raw.groups) {
    need(!groups.some(seen => seen.id === group.id), `group id repeated: ${group.id}`);
    const after = group.after ?? [];
    need(after.every(id => groups.some(seen => seen.id === id)), `group ${group.id}: after names a group not declared before it`);
    const receives = group.receives ?? [];
    for (const received of receives) {
      need(scaffold.has(received) && after.includes(received.split('.')[0]!), `group ${group.id}: receives ${received} must be a scaffold step of a group listed in after`);
    }
    const questions = group.questions.map(normalizeQuestion);
    for (const entry of questions) {
      need(!groupOf.has(entry.id), `question id repeated: ${entry.id}`);
      groupOf.set(entry.id, group.id);
      if (entry.role === 'scaffold') scaffold.add(`${group.id}.${entry.id}`);
    }
    const effort = group.effort ?? defaults.effort;
    groups.push({ id: group.id, judge: group.judge ?? defaults.judge, ...(effort === undefined ? {} : { effort }),
      repeats: group.repeats ?? defaults.repeats, combine: group.combine ?? defaults.combine, after, receives,
      ...(group.reads ? { reads: group.reads.map(normalizeRead) } : {}), questions });
  }
  need(groups.some(group => group.questions.some(entry => entry.role === 'scored')), 'bank has no scored question');
  // A bank declaring any factor is on the ladder: every gate question then carries one, the bank's default or 0.5.
  const laddered = raw.penalty !== undefined || groups.some(group => group.questions.some(entry => entry.penalty !== undefined));
  if (laddered) for (const group of groups) for (const entry of group.questions) if (entry.gate) entry.penalty ??= raw.penalty ?? DEFAULT_PENALTY;
  return { schema: raw.schema, id: raw.id, ...(raw.version === undefined ? {} : { version: raw.version }),
    instructions: raw.instructions, ...(raw.penalty === undefined ? {} : { penalty: raw.penalty }), reads: raw.reads.map(normalizeRead), groups };
}

/** Strict YAML: duplicate keys, aliases and merges are refused. */
export function parseBank(source: string): QuestionBank {
  const document = parseDocument(source, { uniqueKeys: true, version: '1.2', merge: false });
  const issue = [...document.errors, ...document.warnings][0];
  if (issue) throw new BankError(`YAML: ${issue.message.split('\n')[0]}`);
  return validateBank(document.toJS({ maxAliasCount: 0 }));
}

export const bankQuestions = (value: QuestionBank, role?: 'scored' | 'scaffold'): (BankQuestion & { group: string })[] =>
  value.groups.flatMap(group => group.questions.filter(entry => role === undefined || entry.role === role).map(entry => ({ ...entry, group: group.id })));

/** Every context name a bank reads; each must be bound by the check that uses it. */
export const bankContexts = (value: QuestionBank): string[] => [...new Set([...value.reads, ...value.groups.flatMap(group => group.reads ?? [])]
  .flatMap(entry => [entry.from, ...(entry.distinct_from ? [entry.distinct_from] : [])]).filter(from => from.startsWith('context.')).map(from => from.slice(8)))];

export const bankJudges = (value: QuestionBank): string[] => [...new Set(value.groups.map(group => group.judge))];
