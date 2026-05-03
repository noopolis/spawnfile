import { Command } from "commander";

import {
  importClaudeCodeAuth,
  importCodexAuth,
  importEnvFile,
  requireAuthProfile,
  type ResolvedAuthProfile
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
  clearProjectModelFallbacks,
  compileProject,
  initProject,
  removeProjectSurface,
  runProject,
  setProjectPrimaryModel,
  setProjectRuntime,
  setProjectSurfaceAccess,
  showProjectSurfaces,
  syncProjectAuth
} from "../compiler/index.js";
import { isSpawnfileError } from "../shared/index.js";
import { listRuntimeAdapters } from "../runtime/index.js";
import { registerModelCommands } from "./modelCommands.js";
import { registerRuntimeCommands } from "./runtimeCommands.js";
import { registerSurfaceCommands } from "./surfaceCommands.js";
import { registerViewCommand } from "./viewCommand.js";

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
  addAgentProject: typeof addAgentProject; addProjectModelFallback: typeof addProjectModelFallback;
  addProjectSurface: typeof addProjectSurface; addSubagentProject: typeof addSubagentProject;
  addTeamProject: typeof addTeamProject; clearProjectModelFallbacks: typeof clearProjectModelFallbacks;
  importClaudeCodeAuth: typeof importClaudeCodeAuth; importCodexAuth: typeof importCodexAuth;
  importEnvFile: typeof importEnvFile; initProject: typeof initProject;
  listRuntimeAdapters: typeof listRuntimeAdapters; removeProjectSurface: typeof removeProjectSurface;
  requireAuthProfile: typeof requireAuthProfile; runProject: typeof runProject;
  setProjectPrimaryModel: typeof setProjectPrimaryModel; setProjectRuntime: typeof setProjectRuntime;
  setProjectSurfaceAccess: typeof setProjectSurfaceAccess; showProjectSurfaces: typeof showProjectSurfaces;
  syncProjectAuth: typeof syncProjectAuth;
}

const createDefaultHandlers = (): CliHandlers => ({
  buildCompilePlan, buildOrganizationView, buildProject, compileProject,
  addAgentProject, addProjectModelFallback, addProjectSurface,
  addSubagentProject, addTeamProject, clearProjectModelFallbacks,
  importClaudeCodeAuth, importCodexAuth, importEnvFile,
  initProject, listRuntimeAdapters, removeProjectSurface, requireAuthProfile,
  runProject, setProjectPrimaryModel, setProjectRuntime,
  setProjectSurfaceAccess, showProjectSurfaces, syncProjectAuth
});

export interface RunCliOptions {
  handlers?: Partial<CliHandlers>; renderEnvironment?: CliRenderEnvironment; streams?: CliStreams;
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
      streams: optionsOrStreams
    }
  : {
      handlers: optionsOrStreams?.handlers ?? handlerOverrides,
      renderEnvironment: optionsOrStreams?.renderEnvironment ?? createDefaultRenderEnvironment(),
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

const isCommanderError = (error: unknown): error is { code: string; exitCode: number } => {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; exitCode?: unknown };
  return typeof candidate.code === "string"
    && candidate.code.startsWith("commander.")
    && typeof candidate.exitCode === "number";
};

const formatPlanSummary = (plan: Awaited<ReturnType<typeof buildCompilePlan>>): string =>
  [
    `root: ${plan.root}`,
    `nodes: ${plan.nodes.length}`,
    `runtimes: ${Object.keys(plan.runtimes).sort().join(", ") || "none"}`
  ].join("\n");

const formatAuthProfileSummary = (profile: ResolvedAuthProfile): string[] => {
  const envKeys = Object.keys(profile.env).sort();
  const importedKinds = Object.keys(profile.imports).sort();

  return [
    `profile: ${profile.name}`,
    `env: ${envKeys.length > 0 ? envKeys.join(", ") : "none"}`,
    `imports: ${importedKinds.length > 0 ? importedKinds.join(", ") : "none"}`
  ];
};

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
  const program = new Command();
  program.name("spawnfile").description("Spawnfile v0.1 compiler");
  program.exitOverride();
  program.configureOutput({
    outputError: (message, write) => write(message),
    writeErr: (message) => writeCommanderOutput(streams.stderr, message),
    writeOut: (message) => writeCommanderOutput(streams.stdout, message)
  });

  program
    .command("compile")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("-o, --out <directory>", "Output directory")
    .action(async (inputPath: string, options: { out?: string }) => {
      const result = await handlers.compileProject(inputPath, { outputDirectory: options.out });
      streams.stdout(`compiled to ${result.outputDirectory}`);
      streams.stdout(`report: ${result.reportPath}`);
    });

  program
    .command("build")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("-o, --out <directory>", "Output directory")
    .option("-t, --tag <image>", "Docker image tag")
    .action(async (inputPath: string, options: { out?: string; tag?: string }) => {
      const result = await handlers.buildProject(inputPath, {
        imageTag: options.tag,
        outputDirectory: options.out
      });
      streams.stdout(`built image ${result.imageTag}`);
      streams.stdout(`compiled to ${result.outputDirectory}`);
      streams.stdout(`report: ${result.reportPath}`);
    });

  program
    .command("run")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("-o, --out <directory>", "Output directory")
    .option("-t, --tag <image>", "Docker image tag")
    .option("--auth-profile <name>", "Local Spawnfile auth profile")
    .option("--name <container>", "Docker container name")
    .option("--env-file <file>", "Path to an env file for runtime secrets")
    .option("-d, --detach", "Run the container in detached mode")
    .action(
      async (
        inputPath: string,
        options: {
          authProfile?: string;
          detach?: boolean;
          envFile?: string;
          name?: string;
          out?: string;
          tag?: string;
        }
      ) => {
        const result = await handlers.runProject(inputPath, {
          authProfile: options.authProfile,
          containerName: options.name,
          detach: options.detach,
          envFilePath: options.envFile,
          imageTag: options.tag,
          outputDirectory: options.out
        });

        if (options.detach) {
          streams.stdout(`running container ${result.containerName ?? "unknown"}`);
          streams.stdout(`image: ${result.imageTag}`);
        }
      }
    );

  program
    .command("init")
    .argument("[path]", "Directory to initialize", process.cwd())
    .option("--team", "Initialize a team project")
    .option("--runtime <name>", "Runtime for agent scaffolds")
    .action(async (inputPath: string, options: { runtime?: string; team?: boolean }) => {
      const result = await handlers.initProject({
        directory: inputPath,
        runtime: options.runtime,
        team: options.team
      });
      streams.stdout(`initialized ${result.directory}`);
      emitFileLines(streams, "created", result.createdFiles);
    });

  const addCommand = program.command("add").description("Add children to an existing Spawnfile project");

  addCommand
    .command("agent")
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
  registerViewCommand(program, handlers, streams, cliOptions.renderEnvironment);

  program
    .command("validate")
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

  const authCommand = program.command("auth").description("Manage local Spawnfile auth profiles");
  const authImportCommand = authCommand
    .command("import")
    .description("Import auth material into a local auth profile");

  authImportCommand
    .command("env")
    .argument("<file>", "Path to an env file")
    .option("-p, --profile <name>", "Auth profile name", "default")
    .action(async (filePath: string, options: { profile: string }) => {
      const profile = await handlers.importEnvFile(options.profile, filePath);
      emitLines(streams, formatAuthProfileSummary(profile));
    });

  authImportCommand
    .command("claude-code")
    .option("-p, --profile <name>", "Auth profile name", "default")
    .option("--from <directory>", "Source Claude Code config directory")
    .action(async (options: { from?: string; profile: string }) => {
      const profile = await handlers.importClaudeCodeAuth(options.profile, options.from);
      emitLines(streams, formatAuthProfileSummary(profile));
    });

  authImportCommand
    .command("codex")
    .option("-p, --profile <name>", "Auth profile name", "default")
    .option("--from <directory>", "Source Codex config directory")
    .action(async (options: { from?: string; profile: string }) => {
      const profile = await handlers.importCodexAuth(options.profile, options.from);
      emitLines(streams, formatAuthProfileSummary(profile));
    });

  authCommand
    .command("sync")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("-p, --profile <name>", "Auth profile name", "default")
    .option("--env-file <file>", "Path to an env file with model keys and runtime secrets")
    .option("--claude-from <directory>", "Source Claude Code config directory")
    .option("--codex-from <directory>", "Source Codex config directory")
    .action(
      async (
        inputPath: string,
        options: {
          claudeFrom?: string;
          codexFrom?: string;
          envFile?: string;
          profile: string;
        }
      ) => {
        const profile = await handlers.syncProjectAuth(inputPath, {
          claudeCodeDirectory: options.claudeFrom,
          codexDirectory: options.codexFrom,
          envFilePath: options.envFile,
          profileName: options.profile
        });
        emitLines(streams, formatAuthProfileSummary(profile));
      }
    );

  authCommand
    .command("show")
    .option("-p, --profile <name>", "Auth profile name", "default")
    .action(async (options: { profile: string }) => {
      const profile = await handlers.requireAuthProfile(options.profile);
      emitLines(streams, formatAuthProfileSummary(profile));
    });

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error: unknown) {
    if (isCommanderError(error)) {
      return error.exitCode === 0 ? 0 : 1;
    }

    const message = isSpawnfileError(error)
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);

    streams.stderr(message);
    return 1;
  }
};
