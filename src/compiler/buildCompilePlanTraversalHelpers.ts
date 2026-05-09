import {
  type Environment,
  type McpServer,
  type Secret,
  type TeamWorkspace
} from "../manifest/index.js";
import {
  ResolvedDocument,
  ResolvedPackage,
  ResolvedAgentNode,
  ResolvedTeamNode
} from "./types.js";
import {
  loadResolvedDocuments,
  mergeEnv,
  mergeMcpServers,
  mergePackages,
  mergeSecrets
} from "./surfaces.js";

export const DEFAULT_POLICY_MODE = "warn";
export const DEFAULT_POLICY_ON_DEGRADE = "warn";

export type InternalNode = {
  runtimeName: string | null;
  source: string;
  value: ResolvedAgentNode | ResolvedTeamNode;
};

type ResolvedPackageArray = ResolvedPackage[] | undefined;

export const mergeResolvedDocuments = async (
  primaryPath: string,
  primaryDocs: TeamWorkspace["docs"] | undefined,
  fallbackPath: string | undefined,
  fallbackDocs: TeamWorkspace["docs"] | undefined
): Promise<ResolvedDocument[]> => {
  const fallbackResolved = fallbackPath && fallbackDocs
    ? await loadResolvedDocuments(fallbackPath, fallbackDocs)
    : [];
  const primaryResolved = await loadResolvedDocuments(primaryPath, primaryDocs);
  const merged = new Map(primaryResolved.map((doc) => [doc.role, doc]));

  for (const doc of fallbackResolved) {
    if (!merged.has(doc.role)) {
      merged.set(doc.role, doc);
    }
  }

  return [...merged.values()];
};

export const resolveEffectiveEnvironment = (
  sharedEnvironment: Environment | undefined,
  localEnvironment: Environment | undefined
): {
  env: Record<string, string>;
  mcpServers: McpServer[];
  packages: ResolvedPackageArray;
  secrets: Secret[];
} => ({
  env: mergeEnv(sharedEnvironment?.env, localEnvironment?.env),
  mcpServers: mergeMcpServers(sharedEnvironment?.mcp_servers, localEnvironment?.mcp_servers),
  packages: mergePackages(sharedEnvironment?.packages, localEnvironment?.packages),
  secrets: mergeSecrets(sharedEnvironment?.secrets, localEnvironment?.secrets)
});
