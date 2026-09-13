export type DatasetRole = 'train' | 'validation' | 'test';
export type Visibility = 'public' | 'evaluator' | 'raw';
/** Trusted host authorization, never accepted directly from viewer request data. */
export interface ReadAccess {
  audience: 'optimizer' | 'evaluator' | 'viewer' | 'operator';
  phase: 'training' | 'validation' | 'test' | 'replay';
  frozenCandidateIds?: readonly string[];
  releaseTestResults?: boolean;
}
export interface RunManifest {
  schema: 'paideia.run.v1';
  id: string;
  datasetId: string;
  datasetRole: DatasetRole;
  candidateId: string;
  planDigest: string;
  recordId?: string;
  /** Protected evaluator-only metadata; omitted from viewer/optimizer projections. */
  metadata?: unknown;
}
export interface BlobReference { runId: string; id: string; digest: string; size: number }
export interface StoredEvent {
  id: string;
  /** Persistence order only. Native source/causal ordering remains in payload. */
  sequence: number;
  visibility: Visibility;
  payload: unknown;
  digest: string;
}
export interface StoredEvaluation { id: string; visibility: Visibility; report: unknown; digest: string }
export interface Replay {
  manifest: RunManifest;
  events: StoredEvent[];
  evaluations: StoredEvaluation[];
  completeness: 'complete' | 'torn-tail';
  ignoredTailBytes: number;
  redactedEvents: number;
  redactedMetadata: boolean;
}
export interface ExperimentStore {
  createRun(manifest: RunManifest): Promise<void>;
  putBlob(runId: string, bytes: string | Uint8Array, visibility?: Visibility): Promise<BlobReference>;
  readBlob(reference: BlobReference, access: ReadAccess): Promise<Buffer>;
  appendEvent(runId: string, event: { id: string; payload: unknown }, visibility?: Visibility): Promise<'appended' | 'duplicate'>;
  appendEvaluation(runId: string, evaluation: { id: string; report: unknown }, visibility?: Visibility): Promise<void>;
  readReplay(runId: string, access: ReadAccess): Promise<Replay>;
}
