import path from "node:path";
import { chmod } from "node:fs/promises";

import { ensureDirectory, removeDirectory, writeUtf8File } from "../filesystem/index.js";
import {
  createCompileReport,
  createDiagnostic,
  writeCompileReport,
  CapabilityReport,
  CompileReport,
  DiagnosticReport,
  NodeReport
} from "../report/index.js";
import { DEFAULT_OUTPUT_DIRECTORY } from "../shared/index.js";
import {
  assertRuntimeCanCompile,
  createRuntimeLifecycleDiagnostics,
  getRuntimeAdapter
} from "../runtime/index.js";

import { Manifest } from "../manifest/index.js";

import { buildCompilePlan } from "./buildCompilePlan.js";
import { createContainerArtifacts } from "./containerArtifacts.js";
import { generateTeamRosters } from "./teamRoster.js";
import { generateTeamMcpScript, createTeamMcpServerEntry } from "./teamMcp.js";
import { generateSurfaceRouterScript, generateRouterConfig } from "./surfaceRouter.js";
import { CompilePlanNode, ResolvedAgentNode, ResolvedTeamNode } from "./types.js";

const DEFAULT_ROUTER_PORT = 9100;

type PolicyMode = NonNullable<Manifest["policy"]>["mode"];
type OnDegrade = NonNullable<Manifest["policy"]>["on_degrade"];

export interface CompileProjectOptions {
  clean?: boolean;
  outputDirectory?: string;
}

export interface CompileProjectResult {
  outputDirectory: string;
  report: CompileReport;
  reportPath: string;
}

interface CompiledNodeResult {
  emittedFiles: Array<{ content: string; path: string }>;
  kind: "agent" | "team";
  report: NodeReport;
  runtimeName: string | null;
  slug: string;
  value: ResolvedAgentNode | ResolvedTeamNode;
}

const writeEmittedFiles = async (
  outputDirectory: string,
  files: Array<{ content: string; path: string }>
): Promise<void> => {
  await Promise.all(
    files.map(async (file) => {
      const targetPath = path.join(outputDirectory, file.path);
      await ensureDirectory(path.dirname(targetPath));
      await writeUtf8File(targetPath, file.content);
    })
  );
};

const createTeamCapabilities = (
  outcome: CapabilityReport["outcome"],
  message: string
): CapabilityReport[] => [
  { key: "team.members", message, outcome },
  { key: "team.mode", message, outcome },
  { key: "team.lead", message, outcome },
  { key: "team.external", message, outcome },
  { key: "team.auth", message, outcome },
  { key: "team.roster", message, outcome },
  { key: "team.shared", message, outcome },
  { key: "team.nested", message, outcome }
];

const createAgentOutputDirectory = (
  baseDirectory: string,
  node: CompilePlanNode & { value: ResolvedAgentNode }
): string => path.join(baseDirectory, "runtimes", node.runtimeName ?? "unknown", "agents", node.slug);

const createTeamOutputDirectory = (
  baseDirectory: string,
  runtimeName: string,
  node: CompilePlanNode & { value: ResolvedTeamNode }
): string => path.join(baseDirectory, "runtimes", runtimeName, "teams", node.slug);

const compileAgentNode = async (
  baseDirectory: string,
  node: CompilePlanNode & { value: ResolvedAgentNode }
): Promise<CompiledNodeResult> => {
  const runtime = await assertRuntimeCanCompile(node.runtimeName ?? node.value.runtime.name);
  const adapter = getRuntimeAdapter(runtime.name);
  const diagnostics: DiagnosticReport[] = [
    ...createRuntimeLifecycleDiagnostics(runtime)
  ];

  for (const diagnostic of adapter.validateRuntimeOptions?.(node.value.runtime.options) ?? []) {
    diagnostics.push(diagnostic);
  }

  const errorDiagnostic = diagnostics.find((diagnostic) => diagnostic.level === "error");
  if (errorDiagnostic) {
    throw new Error(errorDiagnostic.message);
  }

  const result = await adapter.compileAgent(node.value);
  const outputDirectory = createAgentOutputDirectory(baseDirectory, node);
  await writeEmittedFiles(outputDirectory, result.files);

  return {
    emittedFiles: result.files,
    kind: node.kind,
    report: {
      capabilities: result.capabilities,
      diagnostics: [...diagnostics, ...result.diagnostics],
      id: node.id,
      kind: node.kind,
      output_dir: path.relative(baseDirectory, outputDirectory),
      runtime: runtime.name,
      runtime_ref: runtime.ref,
      runtime_status: runtime.status,
      source: node.value.source
    },
    runtimeName: runtime.name,
    slug: node.slug,
    value: node.value
  };
};

const getTeamRuntimeName = (node: ResolvedTeamNode): string | null => {
  const runtimeNames = [...new Set(node.members.map((member) => member.runtimeName).filter(Boolean))];
  return runtimeNames.length === 1 ? (runtimeNames[0] ?? null) : null;
};

const compileTeamNode = async (
  baseDirectory: string,
  node: CompilePlanNode & { value: ResolvedTeamNode }
): Promise<CompiledNodeResult> => {
  const runtimeName = getTeamRuntimeName(node.value);
  if (!runtimeName) {
    return {
      emittedFiles: [],
      kind: node.kind,
      report: {
        capabilities: createTeamCapabilities(
          "degraded",
          "Team spans multiple runtimes and cannot lower to one native team artifact in v0.1"
        ),
        diagnostics: [
          createDiagnostic(
            "warn",
            `Team ${node.value.name} spans multiple runtimes and was not emitted as a native team artifact`
          )
        ],
        id: node.id,
        kind: node.kind,
        output_dir: null,
        runtime: null,
        runtime_ref: null,
        runtime_status: null,
        source: node.value.source
      },
      runtimeName: null,
      slug: node.slug,
      value: node.value
    };
  }

  const runtime = await assertRuntimeCanCompile(runtimeName);
  const adapter = getRuntimeAdapter(runtime.name);
  const diagnostics = [...createRuntimeLifecycleDiagnostics(runtime)];

  if (!adapter.compileTeam) {
    return {
      emittedFiles: [],
      kind: node.kind,
      report: {
        capabilities: createTeamCapabilities(
          "degraded",
          `Runtime ${runtime.name} does not provide native team compilation in v0.1`
        ),
        diagnostics: [
          ...diagnostics,
          createDiagnostic(
            "warn",
            `Runtime ${runtime.name} did not emit a native team artifact for ${node.value.name}`
          )
        ],
        id: node.id,
        kind: node.kind,
        output_dir: null,
        runtime: runtime.name,
        runtime_ref: runtime.ref,
        runtime_status: runtime.status,
        source: node.value.source
      },
      runtimeName: runtime.name,
      slug: node.slug,
      value: node.value
    };
  }

  const result = await adapter.compileTeam(node.value);
  const outputDirectory = createTeamOutputDirectory(baseDirectory, runtime.name, node);
  await writeEmittedFiles(outputDirectory, result.files);

  return {
    emittedFiles: result.files,
    kind: node.kind,
    report: {
      capabilities: result.capabilities,
      diagnostics: [...diagnostics, ...result.diagnostics],
      id: node.id,
      kind: node.kind,
      output_dir: path.relative(baseDirectory, outputDirectory),
      runtime: runtime.name,
      runtime_ref: runtime.ref,
      runtime_status: runtime.status,
      source: node.value.source
    },
    runtimeName: runtime.name,
    slug: node.slug,
    value: node.value
  };
};

const enforcePolicy = (
  nodeReport: NodeReport,
  policyMode: PolicyMode | null,
  onDegrade: OnDegrade | null
): void => {
  for (const capability of nodeReport.capabilities) {
    if (capability.outcome === "unsupported") {
      if (policyMode === "strict") {
        throw new Error(
          `Policy violation: ${capability.key} is unsupported for ${nodeReport.id} (strict mode)${capability.message ? `: ${capability.message}` : ""}`
        );
      }
    }

    if (capability.outcome === "degraded") {
      if (onDegrade === "error") {
        throw new Error(
          `Policy violation: ${capability.key} is degraded for ${nodeReport.id} (on_degrade: error)${capability.message ? `: ${capability.message}` : ""}`
        );
      }
    }
  }
};

export const compileProject = async (
  inputPath: string,
  options: CompileProjectOptions = {}
): Promise<CompileProjectResult> => {
  const plan = await buildCompilePlan(inputPath);
  const outputDirectory = path.resolve(options.outputDirectory ?? DEFAULT_OUTPUT_DIRECTORY);

  if (options.clean ?? true) {
    await removeDirectory(outputDirectory);
  }
  await ensureDirectory(outputDirectory);

  // Generate team rosters and inject team MCP tool for team members
  const rosterFiles = new Map<string, string>(); // nodeSource -> roster YAML
  const memberAgentIds = new Map<string, string>(); // nodeSource -> member ID
  const teamMcpScript = generateTeamMcpScript();
  for (const node of plan.nodes) {
    if (node.kind === "team") {
      const teamNode = node.value as ResolvedTeamNode;
      const rosters = generateTeamRosters(teamNode, plan, DEFAULT_ROUTER_PORT);
      for (const [memberId, rosterYaml] of rosters) {
        const memberRef = teamNode.members.find((m) => m.id === memberId);
        if (memberRef) {
          rosterFiles.set(memberRef.nodeSource, rosterYaml);
          memberAgentIds.set(memberRef.nodeSource, memberId);
        }
      }
    }
  }

  // Generate surface router artifacts for teams
  const surfaceRouterScript = generateSurfaceRouterScript();
  for (const node of plan.nodes) {
    if (node.kind === "team") {
      const teamNode = node.value as ResolvedTeamNode;
      const routerConfig = generateRouterConfig(teamNode, plan, DEFAULT_ROUTER_PORT);
      await writeUtf8File(
        path.join(outputDirectory, "surface-router.js"),
        surfaceRouterScript
      );
      await writeUtf8File(
        path.join(outputDirectory, "router-config.json"),
        JSON.stringify(routerConfig, null, 2) + "\n"
      );
    }
  }

  const nodeReports: NodeReport[] = [];
  const compiledNodes: CompiledNodeResult[] = [];
  for (const node of plan.nodes) {
    let compiled: CompiledNodeResult;

    if (node.kind === "agent") {
      compiled = await compileAgentNode(outputDirectory, node as CompilePlanNode & { value: ResolvedAgentNode });

      // Write roster and team MCP script for team members
      const rosterYaml = rosterFiles.get(node.value.source);
      if (rosterYaml && compiled.report.output_dir) {
        const agentOutputDir = path.join(outputDirectory, compiled.report.output_dir);
        const agentName = (node.value as ResolvedAgentNode).name;
        const memberId = memberAgentIds.get(node.value.source) ?? agentName;

        await ensureDirectory(path.join(agentOutputDir, ".spawnfile"));
        await writeUtf8File(path.join(agentOutputDir, ".spawnfile", "roster.yaml"), rosterYaml);
        await writeUtf8File(path.join(agentOutputDir, ".spawnfile", "team-mcp.js"), teamMcpScript);

        // Inject team files into emittedFiles so they flow into the container
        compiled.emittedFiles.push(
          {
            content: rosterYaml,
            path: `workspace/${agentName}/.spawnfile/roster.yaml`
          },
          {
            content: teamMcpScript,
            path: `workspace/${agentName}/.spawnfile/team-mcp.js`
          }
        );

        // Gap 3: Append roster to agent AGENTS.md so it's part of the agent context
        const agentsMdPath = `workspace/${agentName}/AGENTS.md`;
        const existingAgentsMd = compiled.emittedFiles.find((f) => f.path === agentsMdPath);
        const rosterBlock = "\n\n## Team Roster\n\nYour team roster is available at `.spawnfile/roster.yaml`. " +
          "Read it to discover your teammates and how to reach them via the `team_message` MCP tool.\n\n" +
          "```yaml\n" + rosterYaml + "```\n";
        if (existingAgentsMd) {
          existingAgentsMd.content += rosterBlock;
        } else {
          compiled.emittedFiles.push({
            content: rosterBlock.trimStart(),
            path: agentsMdPath
          });
        }

        // Gap 4: Register team MCP server in Claude Code .claude/settings.json
        // Use relative path from agent working directory (.spawnfile/team-mcp.js)
        // since Claude Code runs from the agent's workspace dir
        const runtimeName = (node.value as ResolvedAgentNode).runtime.name;
        if (runtimeName === "tinyclaw") {
          const claudeSettings = {
            mcpServers: {
              spawnfile_team: {
                command: "node",
                args: [`.spawnfile/team-mcp.js`],
                env: {
                  SPAWNFILE_ROUTER_URL: `http://localhost:${DEFAULT_ROUTER_PORT}`,
                  SPAWNFILE_AGENT_NAME: memberId
                }
              }
            }
          };
          compiled.emittedFiles.push({
            content: JSON.stringify(claudeSettings, null, 2) + "\n",
            path: `workspace/${agentName}/.claude/settings.json`
          });
        }
      }
    } else {
      compiled = await compileTeamNode(outputDirectory, node as CompilePlanNode & { value: ResolvedTeamNode });
    }

    enforcePolicy(
      compiled.report,
      node.value.policyMode as PolicyMode | null,
      node.value.policyOnDegrade as OnDegrade | null
    );
    nodeReports.push(compiled.report);
    compiledNodes.push(compiled);
  }

  const hasTeamRouter = rosterFiles.size > 0;
  const containerArtifacts = await createContainerArtifacts(plan, compiledNodes, { hasTeamRouter });
  await writeEmittedFiles(outputDirectory, containerArtifacts.files);
  await Promise.all(
    containerArtifacts.executablePaths.map((filePath) =>
      chmod(path.join(outputDirectory, filePath), 0o755)
    )
  );

  const report = createCompileReport(plan.root, nodeReports, [], containerArtifacts.report);
  const reportPath = await writeCompileReport(outputDirectory, report);

  return {
    outputDirectory,
    report,
    reportPath
  };
};
