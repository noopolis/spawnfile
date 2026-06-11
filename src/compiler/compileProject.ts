import path from "node:path";
import { chmod } from "node:fs/promises";

import { ensureDirectory, removeDirectory } from "../filesystem/index.js";
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
import {
  TeamCompileSupport,
  injectMoltnetWorkspaceFiles,
  injectTeamCompileSupportFiles,
  prepareTeamCompileSupport,
  writeEmittedFiles
} from "./compileProjectSupport.js";
import { CompilePlanNode, ResolvedAgentNode, ResolvedTeamNode } from "./types.js";
import { generateMoltnetArtifacts } from "./moltnetArtifacts.js";
import { stageMoltnetBinaries } from "./moltnetBinaries.js";

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
  id: string;
  kind: "agent" | "team";
  report: NodeReport;
  runtimeName: string | null;
  slug: string;
  value: ResolvedAgentNode | ResolvedTeamNode;
}

const createTeamCapabilities = (
  outcome: CapabilityReport["outcome"],
  message: string
): CapabilityReport[] => [
  { key: "team.members", message, outcome },
  { key: "team.mode", message, outcome },
  { key: "team.lead", message, outcome },
  { key: "team.external", message, outcome },
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
  const diagnostics: DiagnosticReport[] = [...createRuntimeLifecycleDiagnostics(runtime)];

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
    id: node.id,
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
      id: node.id,
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
      id: node.id,
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
    id: node.id,
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

      if (policyMode === "warn") {
        nodeReport.diagnostics.push(
          createDiagnostic(
            "warn",
            `Policy warning: ${capability.key} is unsupported for ${nodeReport.id}${capability.message ? `: ${capability.message}` : ""}`
          )
        );
      }
    }

    if (capability.outcome === "degraded") {
      if (onDegrade === "error") {
        throw new Error(
          `Policy violation: ${capability.key} is degraded for ${nodeReport.id} (on_degrade: error)${capability.message ? `: ${capability.message}` : ""}`
        );
      }

      if (onDegrade === "warn") {
        nodeReport.diagnostics.push(
          createDiagnostic(
            "warn",
            `Policy warning: ${capability.key} is degraded for ${nodeReport.id}${capability.message ? `: ${capability.message}` : ""}`
          )
        );
      }
    }
  }
};

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

const augmentNodeReports = (
  compiledNodes: CompiledNodeResult[],
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

    compiled.report.capabilities.push(...createIdentityCapabilities(compiled.value));
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

  const teamCompileSupport = await prepareTeamCompileSupport(plan);

  const nodeReports: NodeReport[] = [];
  const compiledNodes: CompiledNodeResult[] = [];
  for (const node of plan.nodes) {
    let compiled: CompiledNodeResult;

    if (node.kind === "agent") {
      compiled = await compileAgentNode(outputDirectory, node as CompilePlanNode & { value: ResolvedAgentNode });
      await injectTeamCompileSupportFiles(
        outputDirectory,
        compiled,
        teamCompileSupport
      );
    } else {
      compiled = await compileTeamNode(outputDirectory, node as CompilePlanNode & { value: ResolvedTeamNode });
    }

    nodeReports.push(compiled.report);
    compiledNodes.push(compiled);
  }

  augmentNodeReports(compiledNodes, teamCompileSupport);
  for (const compiled of compiledNodes) {
    enforcePolicy(
      compiled.report,
      compiled.value.policyMode as PolicyMode | null,
      compiled.value.policyOnDegrade as OnDegrade | null
    );
  }

  const moltnetArtifacts = await generateMoltnetArtifacts(plan);
  const hasStagedMoltnetBinaries = moltnetArtifacts
    ? await stageMoltnetBinaries(outputDirectory)
    : false;
  await injectMoltnetWorkspaceFiles(outputDirectory, compiledNodes, moltnetArtifacts);
  const containerArtifacts = await createContainerArtifacts(plan, compiledNodes, {
    hasStagedMoltnetBinaries,
    moltnet: moltnetArtifacts
  });
  await writeEmittedFiles(outputDirectory, containerArtifacts.files);
  await Promise.all(
    containerArtifacts.executablePaths.map((filePath) =>
      chmod(path.join(outputDirectory, filePath), 0o755)
    )
  );

  const report = createCompileReport(plan.root, nodeReports, [], containerArtifacts.report, {
    outputDirectory
  });
  const reportPath = await writeCompileReport(outputDirectory, report);

  return { outputDirectory, report, reportPath };
};
