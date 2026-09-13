import type { ObservationCoverage, Usage } from '../src/contracts/index.js';

/** A caller-filtered presentation projection. Never pass raw captures or prompts. */
export interface ViewerData {
  schema: 'paideia.viewer.v1';
  experiment: {
    id: string;
    title: string;
    status: string;
    phase: 'evaluation' | 'train' | 'validation' | 'final-test' | 'replay';
    updatedAt: string;
  };
  cases: { id: string; split: 'train' | 'validation' | 'test'; label?: string }[];
  trials: {
    id: string;
    caseId: string;
    candidateId: string;
    status: string;
    score: number | null;
    coverage: ObservationCoverage[];
    checks: ViewerCheck[];
    events: ViewerEvent[];
  }[];
  candidates: {
    id: string;
    parentIds: string[];
    validationScore: number | null;
    discoveryEvaluations: number;
    editablePaths: string[];
  }[];
  usage: ViewerUsage[];
  optimizer?: {
    name: string;
    status: string;
    evaluations: number;
    proposals: number;
    maxMetricCalls: number;
    maxProposals: number;
    selectedCandidateId?: string;
  };
}

export interface ViewerCheck {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'unknown' | 'error' | 'skipped';
  score: number | null;
  evidenceIds: string[];
  children: ViewerCheck[];
}

export interface ViewerEvent { id: string; type: string; timestamp: string; summary: string }

export interface ViewerUsage {
  purpose: 'subject' | 'optimizer' | 'judge' | 'embedding';
  model: string | null;
  route: string | null;
  usage: Usage | null;
}

export interface ViewerOptions { load: () => Promise<ViewerData>; port?: number }
export interface ViewerServer { url: string; port: number; close(): Promise<void> }
