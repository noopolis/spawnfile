import { readFileSync } from "node:fs";

import type { NormalizedRunCliOptions, CliStreams } from "./runCli.js";

import { loginSubscriptionRealm } from "../runtime/trainingSelection.js";

import { Command, Help, Option } from "commander";

import {
  importClaudeCodeAuth,
  importCodexAuth,
  importGrokAuth,
  importEnvFile,
  initializeTargetSecretSourceLifecycle,
  provisionCredentials,
  requireAuthProfile
} from "../auth/index.js";
import {
  addAgentProject,
  addProjectSurface,
  addProjectModelFallback,
  addSubagentProject,
  addTeamProject,
  buildOrganizationView,
  buildCompilePlan,
  buildProject,
  buildUpReceipt,
  clearProjectModelFallbacks,
  compileProject,
  createTrainingContext,
  createTrainingPlan, loadTrainingProject, resolveTrainingPlan, materializeTrainingMoment, lowerTrainingExecution, lowerTrainingMoments, allocateTrainingOutputParent,
  initProject,
  listInitTemplates,
  preflightCompilePlan,
  publishProject,
  upProject,
  removeProjectSurface,
  runProject,
  setProjectPrimaryModel,
  setProjectRuntime,
  setProjectSurfaceAccess,
  showProjectSurfaces,
  syncProjectAuth
} from "../compiler/index.js";
import {
  devStopProject,
  devUpProject
} from "../dev/index.js";
import { consumeImageUp } from "../distribution/index.js";
import {
  createDockerProbeGateway,
  downDeployment,
  exportRunArtifacts,
  inspectDockerDeployment,
  listDeploymentRecords,
  listHomeDeploymentRecords
} from "../deployment/index.js";
import { listRuntimeAdapters } from "../runtime/index.js";
import { registerArtifactsCommands } from "./artifactsCommands.js";
import { registerAuthCommands } from "./authCommands.js";
import { registerCapabilitiesCommand } from "./capabilitiesCommand.js";
import { registerDevCommands } from "./devCommands.js";
import { registerEvidenceExportHelperCommand } from "./evidenceExportHelperCommand.js";
import { registerLifecycleCommands } from "./lifecycleCommands.js";
import { registerModelCommands } from "./modelCommands.js";
import { registerRuntimeCommands } from "./runtimeCommands.js";
import { registerSurfaceCommands } from "./surfaceCommands.js";
import { registerStatusCommand } from "./statusCommand.js";
import { registerUsageCommand } from "./usageCommand.js";
import { registerRecordCommands } from "./recordCommands.js";
import { registerProductionTargetCommands } from "./targetProductionCommands.js";
import { registerViewCommand } from "./viewCommand.js";
import { registerAdaptersCommands, registerProjectAdapterHook } from "./projectAdapterCommands.js";
import { registerVolumeCommands } from "./volumeCommands.js";
import { registerTrainCommand } from "./trainCommand.js";
import { runTraining } from "./trainingExecution.js";
import { runTrainingRegrade } from "./trainingRegrade.js";

const packageJsonPath = new URL("../../package.json", import.meta.url);

const readPackageVersion = (): string => {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
};

export interface CliHandlers {
  createTrainingContext: typeof createTrainingContext;
  createTrainingPlan: typeof createTrainingPlan;
  lowerTrainingExecution: typeof lowerTrainingExecution; lowerTrainingMoments: typeof lowerTrainingMoments; allocateTrainingOutputParent: typeof allocateTrainingOutputParent;
  loadTrainingProject: typeof loadTrainingProject; resolveTrainingPlan: typeof resolveTrainingPlan;
  materializeTrainingMoment: typeof materializeTrainingMoment;
  runTraining: typeof runTraining;
  runTrainingRegrade: typeof runTrainingRegrade;
  buildCompilePlan: typeof buildCompilePlan; buildOrganizationView: typeof buildOrganizationView;
  buildProject: typeof buildProject; compileProject: typeof compileProject;
  publishProject: typeof publishProject;
  addAgentProject: typeof addAgentProject; addProjectModelFallback: typeof addProjectModelFallback;
  addProjectSurface: typeof addProjectSurface; addSubagentProject: typeof addSubagentProject;
  addTeamProject: typeof addTeamProject; clearProjectModelFallbacks: typeof clearProjectModelFallbacks;
  importClaudeCodeAuth: typeof importClaudeCodeAuth; importCodexAuth: typeof importCodexAuth;
  importGrokAuth: typeof importGrokAuth; loginSubscriptionRealm: typeof loginSubscriptionRealm;
  importEnvFile: typeof importEnvFile; initProject: typeof initProject;
  listInitTemplates: typeof listInitTemplates;
  initializeTargetSecretSourceLifecycle: typeof initializeTargetSecretSourceLifecycle;
  provisionCredentials: typeof provisionCredentials;
  exportRunArtifacts: typeof exportRunArtifacts;
  downDeployment: typeof downDeployment;
  createDockerProbeGateway: typeof createDockerProbeGateway;
  inspectDockerDeployment: typeof inspectDockerDeployment;
  listDeploymentRecords: typeof listDeploymentRecords;
  listHomeDeploymentRecords: typeof listHomeDeploymentRecords;
  listRuntimeAdapters: typeof listRuntimeAdapters; removeProjectSurface: typeof removeProjectSurface;
  requireAuthProfile: typeof requireAuthProfile; runProject: typeof runProject;
  upProject: typeof upProject; buildUpReceipt: typeof buildUpReceipt;
  consumeImageUp: typeof consumeImageUp;
  devStopProject: typeof devStopProject;
  devUpProject: typeof devUpProject;
  setProjectPrimaryModel: typeof setProjectPrimaryModel; setProjectRuntime: typeof setProjectRuntime;
  setProjectSurfaceAccess: typeof setProjectSurfaceAccess; showProjectSurfaces: typeof showProjectSurfaces;
  syncProjectAuth: typeof syncProjectAuth;
}
const createDefaultHandlers = (): CliHandlers => ({
  createTrainingContext, createTrainingPlan, loadTrainingProject, resolveTrainingPlan, materializeTrainingMoment, lowerTrainingExecution, lowerTrainingMoments, allocateTrainingOutputParent, runTraining, runTrainingRegrade,
  buildCompilePlan, buildOrganizationView, buildProject, compileProject, publishProject,
  addAgentProject, addProjectModelFallback, addProjectSurface,
  addSubagentProject, addTeamProject, clearProjectModelFallbacks,
  importClaudeCodeAuth, importCodexAuth, importGrokAuth, importEnvFile, initializeTargetSecretSourceLifecycle,
  loginSubscriptionRealm, provisionCredentials,
  createDockerProbeGateway, exportRunArtifacts, downDeployment, inspectDockerDeployment,
  listDeploymentRecords, listHomeDeploymentRecords,
  initProject, listInitTemplates, listRuntimeAdapters, removeProjectSurface, requireAuthProfile,
  runProject, setProjectPrimaryModel, setProjectRuntime, upProject, buildUpReceipt, consumeImageUp,
  devStopProject, devUpProject,
  setProjectSurfaceAccess, showProjectSurfaces, syncProjectAuth
});

const writeCommanderOutput = (
  write: (message: string) => void,
  message: string
): void => {
  const normalized = message.replace(/\n$/, "");
  if (normalized.length > 0) {
    write(normalized);
  }
};

const formatPlanSummary = (plan: Awaited<ReturnType<typeof buildCompilePlan>>): string =>
  [
    `root: ${plan.root}`,
    `nodes: ${plan.nodes.length}`,
    `runtimes: ${Object.keys(plan.runtimes).sort().join(", ") || "none"}`
  ].join("\n");

const emitLines = (streams: CliStreams, lines: string[]): void =>
  lines.forEach((line) => streams.stdout(line));

const emitFileLines = (streams: CliStreams, label: string, filePaths: string[]): void =>
  emitLines(streams, filePaths.map((filePath) => `${label} ${filePath}`));

export const createCliProgram = (
  cliOptions: NormalizedRunCliOptions,
  isTargetInvocation: boolean
) => {
  const streams = cliOptions.streams;
  const handlers = { ...createDefaultHandlers(), ...cliOptions.handlers };
  let commandExitCode = 0;
  const program = new Command();
  program.name("spawnfile").description("Spawnfile v0.1 compiler").version(readPackageVersion());
  // The global scanner has already handled this option. Advertise it only in help
  // so Commander leaves tokens such as `--config --adapter` to the owning command.
  const adapterHelp = new Option("--adapter <module>", "Load a trusted local ESM adapter or installed package (repeatable)");
  program.configureHelp({
    visibleOptions(this: Help, command) {
      const options = Help.prototype.visibleOptions.call(this, command);
      return command === program ? [adapterHelp, ...options] : options;
    }
  });
  program.exitOverride();
  program.configureOutput({
    outputError: (message, write) => write(message),
    writeErr: (message) => {
      if (!isTargetInvocation) writeCommanderOutput(streams.stderr, message);
    },
    writeOut: (message) => writeCommanderOutput(streams.stdout, message)
  });

  registerProjectAdapterHook(program);
  registerAdaptersCommands(program, streams);
  registerLifecycleCommands(program, handlers, streams, cliOptions.stdin, (code) => { commandExitCode = code; });
  registerDevCommands(program, handlers, streams);
  registerArtifactsCommands(program, handlers, streams);
  registerCapabilitiesCommand(program, streams, readPackageVersion());
  registerEvidenceExportHelperCommand(program, streams, (exitCode) => {
    commandExitCode = exitCode;
  });

  program
    .command("init")
    .description("Scaffold a new Spawnfile project or team in a directory")
    .argument("[path]", "Directory to initialize", process.cwd())
    .option("--team", "Initialize a team project")
    .option("--runtime <name>", "Runtime for agent scaffolds")
    .option("--template <name>", "Scaffold from a bundled example template")
    .option("--list-templates", "List available example templates and exit")
    .action(async (
      inputPath: string,
      options: { runtime?: string; team?: boolean; template?: string; listTemplates?: boolean }
    ) => {
      if (options.listTemplates) {
        const templates = await handlers.listInitTemplates();
        for (const template of templates) {
          streams.stdout(template);
        }
        return;
      }
      const result = await handlers.initProject({
        directory: inputPath,
        runtime: options.runtime,
        team: options.team,
        template: options.template
      });
      streams.stdout(`initialized ${result.directory}`);
      emitFileLines(streams, "created", result.createdFiles);
    });

  const addCommand = program.command("add").description("Add children to an existing Spawnfile project");

  addCommand
    .command("agent")
    .description("Add an agent member to a team project")
    .argument("<id>", "Agent member id")
    .argument("[path]", "Team project directory or Spawnfile path", process.cwd())
    .option("--runtime <name>", "Runtime for the new agent member")
    .action(async (id: string, inputPath: string, options: { runtime?: string }) => {
      const result = await handlers.addAgentProject({
        id,
        path: inputPath,
        runtime: options.runtime
      });
      emitFileLines(streams, "updated", result.updatedFiles);
      emitFileLines(streams, "created", result.createdFiles);
    });

  addCommand
    .command("subagent")
    .description("Add a subagent to an agent project")
    .argument("<id>", "Subagent id")
    .argument("[path]", "Agent project directory or Spawnfile path", process.cwd())
    .action(async (id: string, inputPath: string) => {
      const result = await handlers.addSubagentProject({
        id,
        path: inputPath
      });
      emitFileLines(streams, "updated", result.updatedFiles);
      emitFileLines(streams, "created", result.createdFiles);
    });

  addCommand
    .command("team")
    .description("Add a nested team to a team project")
    .argument("<id>", "Nested team id")
    .argument("[path]", "Team project directory or Spawnfile path", process.cwd())
    .action(async (id: string, inputPath: string) => {
      const result = await handlers.addTeamProject({
        id,
        path: inputPath
      });
      emitFileLines(streams, "updated", result.updatedFiles);
      emitFileLines(streams, "created", result.createdFiles);
    });

  registerModelCommands(program, handlers, streams);
  registerRuntimeCommands(program, handlers, streams);
  registerSurfaceCommands(program, handlers, streams);
  registerStatusCommand(program, handlers, streams, (exitCode) => {
    commandExitCode = exitCode;
  });
  registerUsageCommand(program, streams, (exitCode) => { commandExitCode = exitCode; }, handlers);
  registerRecordCommands(program, streams, (exitCode) => { commandExitCode = exitCode; }, handlers);
  registerViewCommand(program, handlers, streams, cliOptions.renderEnvironment);
  registerTrainCommand(program, handlers, streams, readPackageVersion(), (code) => {
    commandExitCode = code;
  }, cliOptions.signal);
  registerProductionTargetCommands(program, streams, cliOptions.stdin, (exitCode) => {
    commandExitCode = exitCode;
  });
  registerVolumeCommands(program, streams, (exitCode) => {
    commandExitCode = exitCode;
  });

  program
    .command("validate")
    .description("Validate a Spawnfile and report the resolved compile plan")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .action(async (inputPath: string) => {
      const plan = await handlers.buildCompilePlan(inputPath);
      preflightCompilePlan(plan);
      streams.stdout("validation succeeded");
      streams.stdout(formatPlanSummary(plan));
    });

  program
    .command("runtimes")
    .description("List available runtime adapters")
    .action(() => {
      for (const runtimeName of handlers.listRuntimeAdapters()) {
        streams.stdout(runtimeName);
      }
    });

  registerAuthCommands(program, handlers, streams, cliOptions.stdin);

  return { program, exitCode: () => commandExitCode };
};
