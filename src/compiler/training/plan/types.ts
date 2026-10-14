import type { TrainingDataset, TrainingTarget } from "../../../manifest/index.js";
import type { CompilePlan, CompilePlanNode, ResolvedAgentNode } from "../../types.js";

export interface TrainingFileSource {
  sourcePath: string;
  path: string;
}

/** Filesystem observations only; ownership decisions belong to the pure resolver. */
export interface TrainingTargetFile extends TrainingFileSource {
  realPath: string | null;
  regular: boolean;
  nestedManifests: string[];
  error?: string;
}

export interface LoadedTrainingTarget {
  declaredBy: string;
  kind: "agent" | "team";
  directory: string;
  realDirectory: string;
  declaration: TrainingTarget;
  files: TrainingTargetFile[];
}

export interface LoadedTrainingDataset extends TrainingFileSource {
  value: TrainingDataset;
  sha256: string;
}

export interface LoadedTrainingProject {
  root: string;
  manifest: string;
  compilePlan: CompilePlan;
  targets: LoadedTrainingTarget[];
  datasets: Record<string, LoadedTrainingDataset>;
  graders: Record<string, TrainingFileSource>;
}

export type TrainingAgentNode = CompilePlanNode & { value: ResolvedAgentNode };
