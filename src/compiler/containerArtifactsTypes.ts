import type { ContainerReport } from "../report/index.js";
import type {
  EmittedFile,
  RuntimeContainerConfigEnvBinding,
  RuntimeContainerMeta
} from "../runtime/index.js";
import type { ModelAuthMethod } from "../shared/index.js";

import type { ResolvedAgentNode, ResolvedTeamNode } from "./types.js";

export interface ContainerEnvVariable {
  categories: Array<"model" | "project" | "runtime">;
  description: string;
  name: string;
  required: boolean;
}

export interface RuntimeTargetPlan {
  configEnvBindings?: RuntimeContainerConfigEnvBinding[];
  envFiles: Array<{
    envName: string;
    filePath: string;
  }>;
  id: string;
  instancePaths: {
    configPath: string;
    homePath?: string;
    workspacePath: string;
  };
  meta: RuntimeContainerMeta;
  modelAuthMethods: Record<string, ModelAuthMethod>;
  modelSecretsRequired: string[];
  port?: number;
  runtimeName: string;
  runtimeRoot: string;
  targetFiles: EmittedFile[];
}

export interface CompiledNodeArtifact {
  emittedFiles: EmittedFile[];
  kind: "agent" | "team";
  runtimeName: string | null;
  slug: string;
  value: ResolvedAgentNode | ResolvedTeamNode;
}

export interface GeneratedContainerArtifacts {
  executablePaths: string[];
  files: EmittedFile[];
  report: ContainerReport;
}
