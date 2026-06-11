import type { OrganizationView, OrganizationViewTreeNode } from "../compiler/index.js";

export const flattenOrganizationNodes = (
  view: OrganizationView
): OrganizationViewTreeNode[] => {
  const nodes: OrganizationViewTreeNode[] = [];

  const visit = (node: OrganizationViewTreeNode): void => {
    nodes.push(node);
    for (const child of node.children) {
      visit(child.node);
    }
  };

  visit(view.root);
  return nodes;
};

export const countNodesByKind = (
  nodes: OrganizationViewTreeNode[]
): { agents: number; teams: number } => ({
  agents: nodes.filter((node) => node.kind === "agent").length,
  teams: nodes.filter((node) => node.kind === "team").length
});
