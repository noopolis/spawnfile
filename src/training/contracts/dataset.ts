import type { TrainingConfiguration } from './training-config.js';
/** Versioned, runtime-neutral authored and resolved dataset contracts. */
export type DataValue = null | boolean | number | string | DataValue[] | DataMap;
export interface DataMap { [key: string]: DataValue }
export interface FileSelector { resource: string; path: string; sha256: string }
export interface TaskInput {
  prompt?: string;
  data?: DataValue;
  files?: FileSelector[];
  message?: DataMap;
}
export interface CheckNode {
  id?: string;
  eval?: string;
  all?: CheckNode[];
  any?: CheckNode[];
  not?: CheckNode;
  passed?: string;
  score?: string;
  at_least?: number;
  use?: string;
  with?: DataMap;
  [parameter: string]: unknown;
}
export interface Stage {
  id: string;
  checks: CheckNode[];
  when?: CheckNode;
  score?: { linear: Record<string, number> };
  gate?: CheckNode;
}
export interface LiveCheck extends CheckNode {
  id: string;
  on: 'event' | { artifact: string };
  on_fail?: 'continue' | 'stop';
}
export interface TurnBinding {
  event: 'tool.dispatch' | 'tool.complete' | 'output';
  where?: { cel: string };
  distinct: 'event.id' | 'call.id';
  cardinality: 'one';
  value: string;
}
export interface Turn {
  id: string;
  input: TaskInput;
  after?: { turn: string; outcome: 'completed' };
  bind?: Record<string, TurnBinding>;
  /** Scoped to this turn; equal IDs in other turns or terminal checks are independent. */
  checks?: CheckNode[];
}
export interface RecordFields {
  context?: DataMap;
  setup?: DataMap;
  input?: TaskInput;
  reference?: { files?: FileSelector[]; labels?: DataValue };
  outputs?: Record<string, string>;
}
export interface DatasetRecord extends RecordFields {
  id: string;
  group?: string;
  use?: string[];
  turns?: Turn[];
  checks?: CheckNode[];
  stages?: Stage[];
}
export interface Dataset {
  schema: 'paideia.dataset.v1';
  id: string;
  subject?: string;
  training?: TrainingConfiguration;
  setup?: DataMap;
  fixtures?: Record<string, RecordFields>;
  checks?: CheckNode[];
  stages?: Stage[];
  live?: { checks: LiveCheck[] };
  records: DatasetRecord[];
}
export interface DatasetDocument {
  dataset: Dataset;
  sourceName: string;
  sourceDigest: string;
  locations: Record<string, { line: number; column: number }>;
}
export interface ResolvedRecord extends Omit<DatasetRecord, 'use' | 'checks' | 'stages'> {
  fixtureProvenance: string[];
  effectiveStages: Stage[];
  live: { checks: LiveCheck[] };
}
export interface ResolvedDataset {
  schema: 'paideia.dataset.v1';
  id: string;
  subject?: string;
  training?: TrainingConfiguration;
  records: ResolvedRecord[];
  sharedStages: Stage[];
  live: { checks: LiveCheck[] };
  sharedPlanDigest: string;
  sourceDigest: string;
  sourceName: string;
  registryVersions: Record<string, string>;
  criterionFileDigests: Record<string, string>;
}
export interface EvaluatorDefinition {
  version: string;
  kind: 'mechanical' | 'semantic' | 'embedding';
  incremental: boolean;
  /** Supports temporal-finality proofs; not a claim that a current fail is final. */
  stopProof: boolean;
  /** Must reject every unsupported parameter; never execute user-authored code. */
  validate: (parameters: Readonly<Record<string, unknown>>, path: string) => void;
}
export interface RulesetDefinition {
  version: string;
  expand: (parameters: Readonly<DataMap>) => CheckNode;
}
export interface PreparationDefinition {
  version: string;
  /** Both this list and the invocation list must permit a record override. */
  unlockedPaths: readonly string[];
  validate: (parameters: Readonly<DataMap>, path: string) => void;
}
export interface DatasetRegistry {
  evaluators?: Readonly<Record<string, EvaluatorDefinition>>;
  rulesets?: Readonly<Record<string, RulesetDefinition>>;
  preparations?: Readonly<Record<string, PreparationDefinition>>;
  judges?: Readonly<Record<string, { version: string }>>;
  embeddings?: Readonly<Record<string, { version: string }>>;
}
export interface ResolutionOptions {
  registry?: DatasetRegistry;
  subject?: string;
  unlockedSetupPaths?: readonly string[];
  requireGroups?: boolean;
  /** Supplies protected rubric/schema bytes relative to sourceName; required for sidecars. */
  readCriterionFile?: (path: string, sourceName: string) => string | Uint8Array;
}
