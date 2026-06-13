import { createDistributionFingerprint } from "./fingerprint.js";
import {
  DISTRIBUTION_REPORT_IMAGE_PATH,
  DISTRIBUTION_REPORT_VERSION,
  IMAGE_CONTRACT_VERSION
} from "./types.js";
import type {
  DistributionImageLabels,
  DistributionMoltnetNetwork,
  DistributionOrganizationSummary,
  DistributionPersistentMount,
  DistributionPortMapping,
  DistributionReport,
  DistributionRuntimeInstance,
  DistributionSecretCategory,
  DistributionSecretEntry,
  DistributionWorkspaceResource
} from "./types.js";

export interface DistributionEnvVariableInput {
  categories: DistributionSecretCategory[];
  generated: boolean;
  name: string;
  required: boolean;
}

export interface BuildDistributionReportInput {
  envVariables: DistributionEnvVariableInput[];
  generatedAt: string;
  internalPorts: number[];
  modelAuthMethods: Record<string, DistributionRuntimeInstance["model_auth_methods"][string]>;
  moltnetNetworks: DistributionMoltnetNetwork[];
  organization: DistributionOrganizationSummary;
  persistentMounts: DistributionPersistentMount[];
  portMappings: DistributionPortMapping[];
  publishedPorts: number[];
  resources: DistributionWorkspaceResource[];
  runtimeInstances: DistributionRuntimeInstance[];
}

const createSecretCategoryMap = (
  envVariables: DistributionEnvVariableInput[]
): Record<DistributionSecretCategory, DistributionSecretEntry[]> => {
  const secrets: Record<DistributionSecretCategory, DistributionSecretEntry[]> = {
    model: [],
    project: [],
    runtime: [],
    surface: []
  };

  for (const variable of envVariables) {
    for (const category of variable.categories) {
      secrets[category].push({
        generated: variable.generated,
        name: variable.name,
        required: variable.required
      });
    }
  }

  for (const category of Object.keys(secrets) as DistributionSecretCategory[]) {
    secrets[category].sort((left, right) => left.name.localeCompare(right.name));
  }

  return secrets;
};

export const buildDistributionReport = (
  input: BuildDistributionReportInput
): DistributionReport => {
  const body: Omit<DistributionReport, "compile_fingerprint" | "generated_at"> = {
    internal_ports: [...input.internalPorts].sort((left, right) => left - right),
    model_auth_methods: input.modelAuthMethods,
    moltnet: {
      networks: [...input.moltnetNetworks].sort((left, right) =>
        left.id.localeCompare(right.id)
      )
    },
    organization: input.organization,
    persistent_mounts: [...input.persistentMounts].sort((left, right) =>
      left.id.localeCompare(right.id)
    ),
    port_mappings: input.portMappings,
    ports: [...input.publishedPorts].sort((left, right) => left - right),
    resources: input.resources,
    runtime_instances: [...input.runtimeInstances].sort((left, right) =>
      left.id.localeCompare(right.id)
    ),
    secrets: createSecretCategoryMap(input.envVariables),
    version: DISTRIBUTION_REPORT_VERSION
  };

  return {
    compile_fingerprint: createDistributionFingerprint(body),
    generated_at: input.generatedAt,
    ...body
  };
};

export const createDistributionImageLabels = (
  projectSlug: string,
  compileFingerprint: string
): DistributionImageLabels => ({
  "com.spawnfile.compile_fingerprint": compileFingerprint,
  "com.spawnfile.image_contract": IMAGE_CONTRACT_VERSION,
  "com.spawnfile.project": projectSlug,
  "com.spawnfile.report": DISTRIBUTION_REPORT_IMAGE_PATH
});
