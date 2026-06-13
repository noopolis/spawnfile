import type { DistributionReport, DistributionSecretCategory } from "./types.js";

export interface RenderImageInterfaceOptions {
  imageRef: string;
  json?: boolean;
}

export interface ImageInterfaceSummary {
  agents: Array<{ id: string; name: string; runtime: string | null; teams: string[] }>;
  compileFingerprint: string;
  generatedAt: string;
  imageRef: string;
  networks: Array<{ id: string; serverMode: string }>;
  ports: number[];
  project: string;
  requiredSecrets: string[];
  teams: Array<{ agents: string[]; id: string; name: string }>;
}

export const buildImageInterfaceSummary = (
  report: DistributionReport,
  imageRef: string
): ImageInterfaceSummary => {
  const categories: DistributionSecretCategory[] = ["model", "project", "runtime", "surface"];
  const requiredSecrets = new Set<string>();
  for (const category of categories) {
    for (const entry of report.secrets[category]) {
      if (entry.required && !entry.generated) {
        requiredSecrets.add(entry.name);
      }
    }
  }

  return {
    agents: report.organization.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      runtime: agent.runtime,
      teams: agent.teams
    })),
    compileFingerprint: report.compile_fingerprint,
    generatedAt: report.generated_at,
    imageRef,
    networks: report.moltnet.networks.map((network) => ({
      id: network.id,
      serverMode: network.server_mode
    })),
    ports: [...report.ports].sort((left, right) => left - right),
    project: report.organization.project,
    requiredSecrets: [...requiredSecrets].sort(),
    teams: report.organization.teams.map((team) => ({
      agents: team.agents,
      id: team.id,
      name: team.name
    }))
  };
};

export const renderImageInterface = (
  report: DistributionReport,
  options: RenderImageInterfaceOptions
): string => {
  const summary = buildImageInterfaceSummary(report, options.imageRef);
  if (options.json) {
    return JSON.stringify(summary, null, 2);
  }

  const lines: string[] = [];
  lines.push(`Image: ${summary.imageRef}`);
  lines.push(`Project: ${summary.project}`);
  lines.push(`Compiled: ${summary.compileFingerprint} (${summary.generatedAt})`);
  lines.push("Declared status is unavailable for image references (no source).");
  lines.push("");

  lines.push("Agents");
  for (const agent of summary.agents) {
    const runtime = agent.runtime ?? "unbound";
    const teams = agent.teams.length > 0 ? ` teams=${agent.teams.join(",")}` : "";
    lines.push(`  ${agent.id}  ${runtime}${teams}`);
  }

  if (summary.teams.length > 0) {
    lines.push("");
    lines.push("Teams");
    for (const team of summary.teams) {
      lines.push(`  ${team.id}  members=${team.agents.join(",") || "none"}`);
    }
  }

  if (summary.networks.length > 0) {
    lines.push("");
    lines.push("Networks");
    for (const network of summary.networks) {
      lines.push(`  ${network.id}  ${network.serverMode}`);
    }
  }

  lines.push("");
  lines.push("Required secrets");
  if (summary.requiredSecrets.length > 0) {
    for (const secret of summary.requiredSecrets) {
      lines.push(`  ${secret}`);
    }
  } else {
    lines.push("  none");
  }

  if (summary.ports.length > 0) {
    lines.push("");
    lines.push(`Published ports: ${summary.ports.join(", ")}`);
  }

  lines.push("");
  lines.push(`next: spawnfile up ${summary.imageRef} --auth-profile <profile>`);
  if (summary.requiredSecrets.length > 0) {
    lines.push("  supply the required secrets above via that profile or --env-file");
  }

  return lines.join("\n");
};
