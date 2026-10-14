/** Authored controls live in the dataset, never in the subject workspace. */
export interface TrainingModel {
  /** `grok-broker`: short Daimon broker inference grants (training containers); never a desktop login. */
  provider: 'claude-subscription' | 'codex-subscription' | 'grok-subscription' | 'grok-broker' | 'ollama';
  model: string;
  endpoint?: string;
  /** Grok only. `grok-broker` requires it and accepts low, medium or high. */
  reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh';
  /** Native Ollama controls; other providers must reject these fields. */
  think?: boolean;
  keep_alive_seconds?: number;
  max_output_tokens?: number;
  context_window?: number;
}
export interface TrainingRoute {
  model: string;
  fallbacks?: string[];
  attempts?: number;
  timeout_ms?: number;
}
export interface TrainingProposalPolicy {
  strategy?: 'refine' | 'rewrite';
  min_change?: number;
  rewrite_share?: number;
  hypothesis_similarity?: number;
  max_attempts?: number;
  history_entries?: number;
  history_bytes?: number;
}
export interface TrainingOptimizer extends TrainingRoute {
  method?: 'gepa';
  variants?: number;
  keep?: number;
  budget?: { rounds: number };
  selection?: 'pareto' | 'top-k';
  boundaries?: string[];
  patience?: number;
  proposal?: TrainingProposalPolicy;
}
export interface TrainingJudge extends TrainingRoute {
  protocol?: 'citations' | 'evidence-ids';
  template?: { language: 'jinja'; text: string };
  citation_repairs?: 0 | 1;
}
export interface TrainingComparison {
  candidate: { name: string; replacements: { resource: string; source: string }[] };
}
export interface TrainingConfiguration {
  comparison?: TrainingComparison;
  models: Record<string, TrainingModel>;
  judges?: Record<string, TrainingJudge>;
  optimizer?: TrainingOptimizer;
  budget?: { max_trials?: number; max_proposals?: number; timeout_ms?: number };
  cache?: { mode: 'off' | 'exact' | 'persistent'; max_entries?: number; namespace?: string; directory?: string };
  recovery?: { max_attempts?: number };
  test?: string;
  validation?: string;
  validation_groups?: string[];
  seed?: number;
}
