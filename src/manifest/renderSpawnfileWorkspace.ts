import type { DocsBlock, TeamWorkspace } from "./schemas.js";

const withDefinedEntries = (entries: Array<[string, unknown]>): Record<string, unknown> =>
  Object.fromEntries(entries.filter((entry) => entry[1] !== undefined));

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

type WorkspaceResource = NonNullable<TeamWorkspace["resources"]>[number];

const orderWorkspaceResource = (resource: WorkspaceResource): unknown => {
  if (resource.kind === "git") {
    return withDefinedEntries([
      ["id", resource.id],
      ["kind", resource.kind],
      ["url", resource.url],
      ["branch", resource.branch],
      ["ref", resource.ref],
      ["tag", resource.tag],
      ["mount", resource.mount],
      ["mode", resource.mode]
    ]);
  }

  return withDefinedEntries([
    ["id", resource.id],
    ["kind", resource.kind],
    ["mount", resource.mount],
    ["mode", resource.mode],
    ["name", resource.name]
  ]);
};

export const orderWorkspace = (
  workspace: TeamWorkspace | undefined
): TeamWorkspace | undefined => {
  if (!workspace) {
    return undefined;
  }

  return withDefinedEntries([
    ["docs", orderDocs(workspace.docs)],
    ["resources", workspace.resources?.map(orderWorkspaceResource)]
  ]) as unknown as TeamWorkspace;
};
