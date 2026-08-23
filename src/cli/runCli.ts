import { readFileSync } from "node:fs";

import { Command } from "commander";

import {
  importClaudeCodeAuth,
  importCodexAuth,
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
  initProject,
  listInitTemplates,
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
  devActivityProject,
  devApplyProject,
  devRestartProject,
  devStopProject,
  devUpProject
} from "../dev/index.js";
import { consumeImageUp } from "../distribution/index.js";
import { downDeployment, exportRunArtifacts } from "../deployment/index.js";
import { errorExitCode, isSpawnfileError } from "../shared/index.js";
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
import { registerProductionTargetCommands } from "./targetProductionCommands.js";
import { registerViewCommand } from "./viewCommand.js";

const packageJsonPath = new URL("../../package.json", import.meta.url);

const readPackageVersion = (): string => {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    version?: unknown;
  };
  return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
};

export interface CliStreams { stderr: (message: string) => void; stdout: (message: string) => void; }

const createDefaultStreams = (): CliStreams => ({
  stderr: (message) => process.stderr.write(`${message}\n`),
  stdout: (message) => process.stdout.write(`${message}\n`)
});

export interface CliRenderEnvironment {
  ci: boolean;
  noColor: boolean;
  stdoutIsTty: boolean;
}

const createDefaultRenderEnvironment = (): CliRenderEnvironment => ({
  ci: process.env.CI !== undefined && process.env.CI !== "" && process.env.CI !== "0",
  noColor: process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "",
  stdoutIsTty: process.stdout.isTTY === true
});

export interface CliHandlers {
  buildCompilePlan: typeof buildCompilePlan; buildOrganizationView: typeof buildOrganizationView;
  buildProject: typeof buildProject; compileProject: typeof compileProject;
  publishProject: typeof publishProject;
  addAgentProject: typeof addAgentProject; addProjectModelFallback: typeof addProjectModelFallback;
  addProjectSurface: typeof addProjectSurface; addSubagentProject: typeof addSubagentProject;
  addTeamProject: typeof addTeamProject; clearProjectModelFallbacks: typeof clearProjectModelFallbacks;
  importClaudeCodeAuth: typeof importClaudeCodeAuth; importCodexAuth: typeof importCodexAuth;
  importEnvFile: typeof importEnvFile; initProject: typeof initProject;
  listInitTemplates: typeof listInitTemplates;
  initializeTargetSecretSourceLifecycle: typeof initializeTargetSecretSourceLifecycle;
  provisionCredentials: typeof provisionCredentials;
  exportRunArtifacts: typeof exportRunArtifacts;
  downDeployment: typeof downDeployment;
  listRuntimeAdapters: typeof listRuntimeAdapters; removeProjectSurface: typeof removeProjectSurface;
  requireAuthProfile: typeof requireAuthProfile; runProject: typeof runProject;
  upProject: typeof upProject; buildUpReceipt: typeof buildUpReceipt;
  consumeImageUp: typeof consumeImageUp;
  devActivityProject: typeof devActivityProject;
  devApplyProject: typeof devApplyProject;
  devRestartProject: typeof devRestartProject;
  devStopProject: typeof devStopProject;
  devUpProject: typeof devUpProject;
  setProjectPrimaryModel: typeof setProjectPrimaryModel; setProjectRuntime: typeof setProjectRuntime;
  setProjectSurfaceAccess: typeof setProjectSurfaceAccess; showProjectSurfaces: typeof showProjectSurfaces;
  syncProjectAuth: typeof syncProjectAuth;
}

const createDefaultHandlers = (): CliHandlers => ({
  buildCompilePlan, buildOrganizationView, buildProject, compileProject, publishProject,
  addAgentProject, addProjectModelFallback, addProjectSurface,
  addSubagentProject, addTeamProject, clearProjectModelFallbacks,
  importClaudeCodeAuth, importCodexAuth, importEnvFile, initializeTargetSecretSourceLifecycle,
  provisionCredentials,
  exportRunArtifacts, downDeployment,
  initProject, listInitTemplates, listRuntimeAdapters, removeProjectSurface, requireAuthProfile,
  runProject, setProjectPrimaryModel, setProjectRuntime, upProject, buildUpReceipt, consumeImageUp,
  devActivityProject, devApplyProject, devRestartProject, devStopProject, devUpProject,
  setProjectSurfaceAccess, showProjectSurfaces, syncProjectAuth
});

export interface RunCliOptions {
  handlers?: Partial<CliHandlers>; renderEnvironment?: CliRenderEnvironment; stdin?: AsyncIterable<unknown>; streams?: CliStreams;
}

const isCliStreams = (value: CliStreams | RunCliOptions | undefined): value is CliStreams => {
  const candidate = value as Partial<CliStreams> | undefined;
  return typeof candidate?.stderr === "function" && typeof candidate.stdout === "function";
};

const normalizeRunCliOptions = (
  optionsOrStreams?: CliStreams | RunCliOptions,
  handlerOverrides: Partial<CliHandlers> = {}
): Required<RunCliOptions> => isCliStreams(optionsOrStreams)
  ? {
      handlers: handlerOverrides,
      renderEnvironment: createDefaultRenderEnvironment(),
      stdin: process.stdin,
      streams: optionsOrStreams
    }
  : {
      handlers: optionsOrStreams?.handlers ?? handlerOverrides,
      renderEnvironment: optionsOrStreams?.renderEnvironment ?? createDefaultRenderEnvironment(),
      stdin: optionsOrStreams?.stdin ?? process.stdin,
      streams: optionsOrStreams?.streams ?? createDefaultStreams()
    };

const writeCommanderOutput = (
  write: (message: string) => void,
  message: string
): void => {
  const normalized = message.replace(/\n$/, "");
  if (normalized.length > 0) {
    write(normalized);
  }
};

const TARGET_CLI_USAGE_ERROR = "error: Invalid target command";

const isCommanderError = (error: unknown): error is { code: string; exitCode: number } => {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; exitCode?: unknown };
  return typeof candidate.code === "string"
    && candidate.code.startsWith("commander.")
    && typeof candidate.exitCode === "number";
};


const formatCliErrorMessage = (error: unknown): string => {
  if (isSpawnfileError(error)) {
    // Surface the human message only; the internal code is not user-facing.
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
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

type RunCli = {
  (argv: string[], options?: RunCliOptions): Promise<number>;
  (
    argv: string[], streams?: CliStreams, handlerOverrides?: Partial<CliHandlers>
  ): Promise<number>;
};

export const runCli: RunCli = async (
  argv: string[],
  optionsOrStreams?: CliStreams | RunCliOptions,
  handlerOverrides: Partial<CliHandlers> = {}
): Promise<number> => {
  const cliOptions = normalizeRunCliOptions(optionsOrStreams, handlerOverrides);
  const streams = cliOptions.streams;
  const handlers = { ...createDefaultHandlers(), ...cliOptions.handlers };
  const isTargetInvocation = argv[0] === "target";
  let commandExitCode: 0 | 1 | 2 = 0;
  const program = new Command();
  program.name("spawnfile").description("Spawnfile v0.1 compiler").version(readPackageVersion());
  program.exitOverride();
  program.configureOutput({
    outputError: (message, write) => write(message),
    writeErr: (message) => {
      if (!isTargetInvocation) writeCommanderOutput(streams.stderr, message);
    },
    writeOut: (message) => writeCommanderOutput(streams.stdout, message)
  });

  registerLifecycleCommands(program, handlers, streams, cliOptions.stdin);
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
  registerViewCommand(program, handlers, streams, cliOptions.renderEnvironment);
  registerProductionTargetCommands(program, streams, cliOptions.stdin, (exitCode) => {
    commandExitCode = exitCode;
  });

  program
    .command("validate")
    .description("Validate a Spawnfile and report the resolved compile plan")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .action(async (inputPath: string) => {
      const plan = await handlers.buildCompilePlan(inputPath);
      streams.stdout("validation succeeded");
      streams.stdout(formatPlanSummary(plan));
    });

  program
    .command("runtimes")
    .description("List bundled runtime adapters")
    .action(() => {
      for (const runtimeName of handlers.listRuntimeAdapters()) {
        streams.stdout(runtimeName);
      }
    });

  registerAuthCommands(program, handlers, streams, cliOptions.stdin);

  try {
    await program.parseAsync(argv, { from: "user" });
    return commandExitCode;
  } catch (error: unknown) {
    if (isCommanderError(error)) {
      if (isTargetInvocation && error.exitCode !== 0) {
        streams.stderr(TARGET_CLI_USAGE_ERROR);
      }
      // Commander prints its own usage message; usage errors exit 2.
      return error.exitCode === 0 ? 0 : 2;
    }

    streams.stderr(`error: ${formatCliErrorMessage(error)}`);
    // Usage/input errors exit 2; runtime failures exit 1, matching the
    // documented status exit-code contract across all commands.
    return errorExitCode(error);
  }
};
