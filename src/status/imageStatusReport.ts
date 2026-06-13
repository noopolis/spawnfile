import type { DistributionReport } from "../distribution/index.js";

import type { LoadedCompileReport, StatusReport } from "./compileReport.js";

/**
 * Maps a cached distribution report (from a sourceless image deployment) into
 * the StatusReport shape so live status can render the compiled, deployment,
 * and runtime layers without project source. Moltnet server plans are not part
 * of the distribution report, so the network layer falls back to `unknown`.
 */
export const distributionReportToStatusReport = (
  report: DistributionReport,
  reportPath: string
): StatusReport => ({
  compileFingerprint: report.compile_fingerprint,
  generatedAt: report.generated_at,
  internalPorts: report.internal_ports,
  moltnetServers: [],
  nodes: [
    ...report.organization.agents.map((agent) => ({
      capabilities: [],
      diagnostics: [],
      id: agent.id,
      kind: "agent" as const,
      outputDir: null,
      runtime: agent.runtime
    })),
    ...report.organization.teams.map((team) => ({
      capabilities: [],
      diagnostics: [],
      id: team.id,
      kind: "team" as const,
      outputDir: null,
      runtime: null
    }))
  ],
  outputDirectory: null,
  persistentMounts: report.persistent_mounts.map((mount) => ({
    id: mount.id,
    mountPath: mount.target,
    reason: "image persistent mount",
    volumeName: ""
  })),
  portMappings: report.port_mappings.map((mapping) => ({
    internalPort: mapping.internal_port,
    publishedPort: mapping.published_port
  })),
  publishedPorts: report.ports,
  reportPath,
  root: null,
  runtimeInstances: report.runtime_instances.map((instance) => ({
    configPath: instance.config_path,
    homePath: instance.home_path,
    id: instance.id,
    internalPort: instance.internal_port,
    nodeIds: instance.node_ids,
    publishedPort: instance.published_port,
    runtime: instance.runtime,
    workspacePath: instance.workspace_path
  })),
  secretsRequired: [
    ...new Set(
      (["model", "project", "runtime", "surface"] as const).flatMap((category) =>
        report.secrets[category]
          .filter((entry) => entry.required && !entry.generated)
          .map((entry) => entry.name)
      )
    )
  ].sort(),
  workspaceResources: report.resources.map((resource) => ({
    backingPath: "",
    id: resource.id,
    kind: resource.kind,
    linkPath: resource.link_path,
    mode: resource.mode,
    mount: resource.mount,
    sharing: resource.sharing
  }))
});

export const loadedImageCompileReport = (
  report: DistributionReport,
  reportPath: string
): LoadedCompileReport => ({
  kind: "loaded",
  report: distributionReportToStatusReport(report, reportPath),
  reportPath
});
