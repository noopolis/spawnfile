import type { ContainerReport } from "../report/index.js";
import type { EmittedFile, RuntimeContainerMeta } from "../runtime/index.js";

import type { ResolvedAgentNode, ResolvedTeamNode } from "./types.js";

export interface ContainerEnvVariable {
  description: string;
  name: string;
  required: boolean;
}

export interface RuntimeTargetPlan {
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
