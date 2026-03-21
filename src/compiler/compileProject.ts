import path from "node:path";

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
import { CompilePlanNode, ResolvedAgentNode, ResolvedTeamNode } from "./types.js";

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
  { key: "team.structure.mode", message, outcome },
  { key: "team.structure.leader", message, outcome },
  { key: "team.structure.external", message, outcome },
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
): Promise<NodeReport> => {
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
    capabilities: result.capabilities,
    diagnostics: [...diagnostics, ...result.diagnostics],
    id: node.id,
    kind: node.kind,
    output_dir: path.relative(baseDirectory, outputDirectory),
    runtime: runtime.name,
    runtime_ref: runtime.ref,
    runtime_status: runtime.status,
    source: node.value.source
  };
};

const getTeamRuntimeName = (node: ResolvedTeamNode): string | null => {
  const runtimeNames = [...new Set(node.members.map((member) => member.runtimeName).filter(Boolean))];
  return runtimeNames.length === 1 ? (runtimeNames[0] ?? null) : null;
};

const compileTeamNode = async (
  baseDirectory: string,
  node: CompilePlanNode & { value: ResolvedTeamNode }
): Promise<NodeReport> => {
  const runtimeName = getTeamRuntimeName(node.value);
  if (!runtimeName) {
    return {
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
    };
  }

  const runtime = await assertRuntimeCanCompile(runtimeName);
  const adapter = getRuntimeAdapter(runtime.name);
  const diagnostics = [...createRuntimeLifecycleDiagnostics(runtime)];

  if (!adapter.compileTeam) {
    return {
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
    };
  }

  const result = await adapter.compileTeam(node.value);
  const outputDirectory = createTeamOutputDirectory(baseDirectory, runtime.name, node);
  await writeEmittedFiles(outputDirectory, result.files);

  return {
    capabilities: result.capabilities,
    diagnostics: [...diagnostics, ...result.diagnostics],
    id: node.id,
    kind: node.kind,
    output_dir: path.relative(baseDirectory, outputDirectory),
    runtime: runtime.name,
    runtime_ref: runtime.ref,
    runtime_status: runtime.status,
    source: node.value.source
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

  const nodeReports: NodeReport[] = [];
  for (const node of plan.nodes) {
    let report: NodeReport;

    if (node.kind === "agent") {
      report = await compileAgentNode(outputDirectory, node as CompilePlanNode & { value: ResolvedAgentNode });
    } else {
      report = await compileTeamNode(outputDirectory, node as CompilePlanNode & { value: ResolvedTeamNode });
    }

    enforcePolicy(
      report,
      node.value.policyMode as PolicyMode | null,
      node.value.policyOnDegrade as OnDegrade | null
    );
    nodeReports.push(report);
  }

  const report = createCompileReport(plan.root, nodeReports);
  const reportPath = await writeCompileReport(outputDirectory, report);

  return {
    outputDirectory,
    report,
    reportPath
  };
};
