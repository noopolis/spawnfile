/* v8 ignore file -- type-only module */
import type { DistributionReport } from "../distribution/index.js";
import type { ContainerReport } from "../report/index.js";
import type {
  EmittedFile,
  RuntimeContainerConfigEnvBinding,
  RuntimeContainerMeta
} from "../runtime/index.js";
import type { ModelAuthMethod } from "../shared/index.js";

import type { ResolvedAgentNode, ResolvedPackage, ResolvedTeamNode } from "./types.js";
import type { MoltnetNodePlan, MoltnetServerPlan } from "./moltnetArtifacts.js";
import type { WorkspaceResourcePlan } from "./workspaceResources.js";

export interface ContainerEnvVariable {
  categories: Array<"model" | "project" | "runtime" | "surface">;
  description: string;
  generated: boolean;
  name: string;
  required: boolean;
}

export interface RuntimeTargetPlan {
  configEnvBindings?: RuntimeContainerConfigEnvBinding[];
  packages?: ResolvedPackage[];
  envFiles: Array<{
    envName: string;
    filePath: string;
  }>;
  id: string;
  instancePaths: {
    configPath: string;
    homePath?: string;
    instanceRoot?: string;
    workspacePath: string;
  };
  meta: RuntimeContainerMeta;
  modelAuthMethods: Record<string, ModelAuthMethod>;
  modelSecretsRequired: string[];
  port?: number;
  publishedPort?: number;
  resources?: WorkspaceResourcePlan[];
  runtimeName: string;
  runtimeRoot: string;
  sourceIds?: string[];
  targetConfigEnvBindings?: RuntimeContainerConfigEnvBinding[];
  targetFiles: EmittedFile[];
}

export interface CompiledNodeArtifact {
  emittedFiles: EmittedFile[];
  id?: string;
  kind: "agent" | "team";
  runtimeName: string | null;
  slug: string;
  value: ResolvedAgentNode | ResolvedTeamNode;
}

export interface GeneratedContainerArtifacts {
  distribution: {
    fingerprint: string;
    labels: Record<string, string>;
    report: DistributionReport;
  };
  executablePaths: string[];
  files: EmittedFile[];
  moltnet?: {
    nodePlans: MoltnetNodePlan[];
    serverPlans: MoltnetServerPlan[];
  };
  report: ContainerReport;
}
