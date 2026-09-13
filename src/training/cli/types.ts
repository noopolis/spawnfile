import type { InferenceProvider, SubjectAdapter } from '../contracts/index.js';
import type { BlobReference } from '../storage/index.js';

export interface CliIO {
  cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
  signal?: AbortSignal;
}

/** Tests inject only the native/inference boundaries; experiment/storage code stays real. */
export interface CliDependencies {
  adapter?: (runtime: 'codex' | 'daimon', options: { model: string; timeoutMs: number }) => SubjectAdapter;
  inference?: (timeoutMs: number) => InferenceProvider;
}

export interface InvocationIndex {
  schema: 'paideia.invocation.v1';
  command: 'evaluate' | 'train';
  summaryRunId: string;
  phase: 'train' | 'test';
  candidateId: string;
  trialIds: string[];
  report: BlobReference;
  candidate: BlobReference;
}
