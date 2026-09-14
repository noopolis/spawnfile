/** Authored controls live in the dataset, never in the subject workspace. */
export interface TrainingModel {
  provider: 'claude-subscription' | 'grok-subscription' | 'ollama';
  model: string;
  endpoint?: string;
  reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh';
}
export interface TrainingRoute {
  model: string;
  fallbacks?: string[];
  attempts?: number;
  timeout_ms?: number;
}
export interface TrainingJudge extends TrainingRoute {
  template?: { language: 'jinja'; text: string };
  citation_repairs?: 0 | 1;
}
export interface TrainingConfiguration {
  models: Record<string, TrainingModel>;
  judges?: Record<string, TrainingJudge>;
  optimizer?: TrainingRoute;
  budget?: { max_trials?: number; max_proposals?: number; timeout_ms?: number };
  cache?: { mode: 'off' | 'exact' | 'persistent'; max_entries?: number; namespace?: string; directory?: string };
  recovery?: { max_attempts?: number };
  test?: string;
  validation_groups?: string[];
  seed?: number;
}
