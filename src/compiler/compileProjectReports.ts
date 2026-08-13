import type { CapabilityReport, NodeReport } from "../report/index.js";

import type { TeamCompileSupport } from "./compileProjectSupport.js";
import type { ResolvedAgentNode, ResolvedTeamNode } from "./types.js";

interface ReportTarget {
  report: NodeReport;
  value: ResolvedAgentNode | ResolvedTeamNode;
}

const createIdentityCapabilities = (
  node: ResolvedAgentNode
): CapabilityReport[] => [
  ...(node.surfaces?.slack?.identity
    ? [{
        key: "surfaces.slack.identity",
        message: "Declared Slack identity was preserved for roster output",
        outcome: "supported" as const
      }]
    : []),
  ...(node.surfaces?.discord?.identity
    ? [{
        key: "surfaces.discord.identity",
        message: "Declared Discord identity was preserved for roster output",
        outcome: "supported" as const
      }]
    : []),
  ...(node.surfaces?.telegram?.identity
    ? [{
        key: "surfaces.telegram.identity",
        message: "Declared Telegram identity was preserved for roster output",
        outcome: "supported" as const
      }]
    : []),
  ...(node.surfaces?.whatsapp?.identity
    ? [{
        key: "surfaces.whatsapp.identity",
        message: "Declared WhatsApp identity was preserved for roster output",
        outcome: "supported" as const
      }]
    : [])
];

const createWorkspaceResourceCapabilities = (
  node: ResolvedAgentNode | ResolvedTeamNode
): CapabilityReport[] =>
  (node.workspaceResources?.length ?? 0) > 0
    ? [{
        key: "workspace.resources",
        message: `${node.workspaceResources?.length ?? 0} workspace resource(s) will be prepared at startup`,
        outcome: "supported" as const
      }]
    : [];

export const augmentNodeReports = (
  compiledNodes: ReportTarget[],
  support: TeamCompileSupport
): void => {
  for (const compiled of compiledNodes) {
    compiled.report.capabilities.push(...createWorkspaceResourceCapabilities(compiled.value));

    if (compiled.value.kind === "team") {
      compiled.report.capabilities.push(
        ...(support.capabilitiesByTeamSource.get(compiled.value.source) ?? [])
      );
      compiled.report.diagnostics.push(
        ...(support.diagnosticsByTeamSource.get(compiled.value.source) ?? [])
      );
      continue;
    }

    const activeEnvironments = support.activeEnvironmentsByAgentSource.get(compiled.value.source);
    if (activeEnvironments) {
      compiled.report.active_environments = activeEnvironments;
    }

    compiled.report.capabilities.push(...createIdentityCapabilities(compiled.value));
  }
};
