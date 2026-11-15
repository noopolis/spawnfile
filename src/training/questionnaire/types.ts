export const QUESTIONNAIRE_SCHEMA = 'spawnfile.training.questionnaire.v1' as const;
/** Fixed answering rules and reply shape; part of every judgment's identity. */
export const QUESTIONNAIRE_PROMPT_VERSION = 'questionnaire-prompt-1' as const;

export const scoredTypes = ['yes-no', 'multiple-choice', 'number'] as const;
export const scaffoldTypes = ['free-text', 'extraction-list'] as const;
export const combineModes = ['majority', 'any-fail', 'all-fail', 'mean'] as const;
export type QuestionType = (typeof scoredTypes)[number] | (typeof scaffoldTypes)[number];
export type CombineMode = (typeof combineModes)[number];

/** One piece of material shown to the judge: a field of the graded output or a bound context value. */
export interface BankRead {
  /** `output`, `output.<field path>` or `context.<name>`. */
  from: string;
  title: string;
  /** Renders an array one item per line, labelled `<list>1`, `<list>2`, ... */
  list?: string;
  /** Per-item lines with `{field.path}` placeholders; a line whose placeholders are all absent is dropped. */
  template?: string;
  /** Drops items already present in this other read, compared on `by`. */
  distinct_from?: string;
  by?: string[];
}

export interface BankOption { id: string; when: string; score: number }

export interface BankQuestion {
  id: string;
  type: QuestionType;
  role: 'scored' | 'scaffold';
  ask: string;
  yes_when?: string;
  no_when?: string;
  /** The yes-no answer that passes. */
  pass?: 'yes' | 'no';
  options?: BankOption[];
  pass_when?: { min?: number; max?: number };
  /** Rising `max` bounds; a number above the last band scores 0. */
  bands?: { max: number; score: number }[];
  pass_min: number;
  weight: number;
  gate: boolean;
  hidden: boolean;
  na_when?: string;
  rule?: string;
}

export interface BankGroup {
  id: string;
  /** A named judge route of the run. */
  judge: string;
  /** Required reasoning effort of that route; a route declaring another effort is refused. */
  effort?: string;
  repeats: number;
  combine: CombineMode;
  after: string[];
  /** `<group>.<scaffold question>` answers of earlier groups shown to this group's judge. */
  receives: string[];
  reads?: BankRead[];
  questions: BankQuestion[];
}

export interface QuestionBank {
  schema: typeof QUESTIONNAIRE_SCHEMA;
  id: string;
  version?: number | string;
  /** The judge's role and the terms the questions use; the bank's own words. */
  instructions: string;
  reads: BankRead[];
  groups: BankGroup[];
}

export interface AnswerRecord {
  id: string;
  type: QuestionType;
  status: 'ok' | 'na' | 'error';
  answer: unknown;
  score: number | null;
  passed: boolean | null;
  reason: string;
  error?: string;
  /** Every repeat's answer, when the group repeats. */
  votes?: unknown[];
}

export interface QuestionnaireScore {
  gate: 'pass' | 'fail' | 'error';
  gateFailures: string[];
  errors: string[];
  score: number | null;
  scoreHidden: number | null;
  scoreOpen: number | null;
}

export interface ScoredAnswer extends AnswerRecord { group: string; ask: string; hidden: boolean; gate: boolean; weight: number }
