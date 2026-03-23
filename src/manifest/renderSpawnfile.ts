import YAML from "yaml";

import type {
  AgentManifest,
  DocsBlock,
  ExecutionBlock,
  RuntimeBinding,
  SharedSurface,
  TeamManifest
} from "./schemas.js";

const withDefinedEntries = (entries: Array<[string, unknown]>): Record<string, unknown> =>
  Object.fromEntries(entries.filter((entry) => entry[1] !== undefined));

const hasEntries = (value: Record<string, unknown>): boolean => Object.keys(value).length > 0;

const orderRuntimeBinding = (
  runtime: RuntimeBinding | undefined
): RuntimeBinding | undefined => {
  if (!runtime || typeof runtime === "string") {
    return runtime;
  }

  return withDefinedEntries([
    ["name", runtime.name],
    ["options", runtime.options]
  ]) as unknown as RuntimeBinding;
};

const orderDocs = (docs: DocsBlock | undefined): DocsBlock | undefined => {
  if (!docs) {
    return undefined;
  }

  return withDefinedEntries([
    ["identity", docs.identity],
    ["soul", docs.soul],
    ["system", docs.system],
    ["memory", docs.memory],
    ["heartbeat", docs.heartbeat],
    ["extras", docs.extras]
  ]) as unknown as DocsBlock;
};

const orderExecution = (
  execution: ExecutionBlock | undefined
): ExecutionBlock | undefined => {
  if (!execution) {
    return undefined;
  }

  return withDefinedEntries([
    [
      "model",
      execution.model
        ? withDefinedEntries([
            ["primary", execution.model.primary],
            ["fallback", execution.model.fallback],
            ["auth", execution.model.auth]
          ])
        : undefined
    ],
    ["workspace", execution.workspace],
    ["sandbox", execution.sandbox]
  ]) as unknown as ExecutionBlock;
};

const orderSharedSurface = (
  shared: SharedSurface | undefined
): SharedSurface | undefined => {
  if (!shared) {
    return undefined;
  }

  return withDefinedEntries([
    ["env", shared.env],
    ["mcp_servers", shared.mcp_servers],
    ["secrets", shared.secrets],
    ["skills", shared.skills]
  ]) as unknown as SharedSurface;
};

const renderSections = (sections: Record<string, unknown>[]): string =>
  sections
    .filter(hasEntries)
    .map((section) => YAML.stringify(section))
    .join("\n");

const orderAgentManifestSections = (manifest: AgentManifest): Record<string, unknown>[] => [
  withDefinedEntries([
    ["spawnfile_version", manifest.spawnfile_version],
    ["kind", manifest.kind],
    ["name", manifest.name]
  ]),
  withDefinedEntries([["runtime", orderRuntimeBinding(manifest.runtime)]]),
  withDefinedEntries([["execution", orderExecution(manifest.execution)]]),
  withDefinedEntries([["docs", orderDocs(manifest.docs)]]),
  withDefinedEntries([
    ["skills", manifest.skills],
    ["mcp_servers", manifest.mcp_servers],
    ["secrets", manifest.secrets],
    ["env", manifest.env],
    ["policy", manifest.policy]
  ]),
  withDefinedEntries([["subagents", manifest.subagents]])
];

const orderTeamManifestSections = (manifest: TeamManifest): Record<string, unknown>[] => [
  withDefinedEntries([
    ["spawnfile_version", manifest.spawnfile_version],
    ["kind", manifest.kind],
    ["name", manifest.name]
  ]),
  withDefinedEntries([["runtime", orderRuntimeBinding(manifest.runtime)]]),
  withDefinedEntries([["execution", orderExecution(manifest.execution)]]),
  withDefinedEntries([
    ["docs", orderDocs(manifest.docs)],
    ["shared", orderSharedSurface(manifest.shared)]
  ]),
  withDefinedEntries([
    ["skills", manifest.skills],
    ["mcp_servers", manifest.mcp_servers],
    ["secrets", manifest.secrets],
    ["env", manifest.env],
    ["policy", manifest.policy]
  ]),
  withDefinedEntries([
    ["members", manifest.members],
    ["structure", manifest.structure]
  ])
];

export const renderSpawnfile = (manifest: AgentManifest | TeamManifest): string =>
  renderSections(
    manifest.kind === "agent"
      ? orderAgentManifestSections(manifest)
      : orderTeamManifestSections(manifest)
  );
