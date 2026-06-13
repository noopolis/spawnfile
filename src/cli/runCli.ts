import { readFileSync } from "node:fs";

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
import { isSpawnfileError } from "../shared/index.js";
import { listRuntimeAdapters } from "../runtime/index.js";
import { registerLifecycleCommands } from "./lifecycleCommands.js";
import { registerModelCommands } from "./modelCommands.js";
import { registerRuntimeCommands } from "./runtimeCommands.js";
import { registerSurfaceCommands } from "./surfaceCommands.js";
import { registerStatusCommand } from "./statusCommand.js";
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
  listRuntimeAdapters: typeof listRuntimeAdapters; removeProjectSurface: typeof removeProjectSurface;
  requireAuthProfile: typeof requireAuthProfile; runProject: typeof runProject;
  upProject: typeof upProject;
  setProjectPrimaryModel: typeof setProjectPrimaryModel; setProjectRuntime: typeof setProjectRuntime;
  setProjectSurfaceAccess: typeof setProjectSurfaceAccess; showProjectSurfaces: typeof showProjectSurfaces;
  syncProjectAuth: typeof syncProjectAuth;
}

const createDefaultHandlers = (): CliHandlers => ({
  buildCompilePlan, buildOrganizationView, buildProject, compileProject, publishProject,
  addAgentProject, addProjectModelFallback, addProjectSurface,
  addSubagentProject, addTeamProject, clearProjectModelFallbacks,
  importClaudeCodeAuth, importCodexAuth, importEnvFile,
  initProject, listRuntimeAdapters, removeProjectSurface, requireAuthProfile,
  runProject, setProjectPrimaryModel, setProjectRuntime, upProject,
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

// Usage/input failures exit 2; runtime failures exit 1.
const USAGE_ERROR_CODES = new Set(["validation_error", "invalid_manifest"]);

const cliErrorExitCode = (error: unknown): number =>
  isSpawnfileError(error) && USAGE_ERROR_CODES.has(error.code) ? 2 : 1;

const formatCliErrorMessage = (error: unknown): string => {
  if (isSpawnfileError(error)) {
    // Surface the human message only; the internal code is not user-facing.
    return error.message;
  }
  if (error instanceof Error) {
    // Turn a raw missing-Spawnfile fs error into actionable guidance.
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT" && /Spawnfile/.test(error.message)) {
      return "No Spawnfile found at that path. Pass a project directory or Spawnfile path, or run 'spawnfile init'.";
    }
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
  let commandExitCode: 0 | 1 | 2 = 0;
  const program = new Command();
  program.name("spawnfile").description("Spawnfile v0.1 compiler").version(readPackageVersion());
  program.exitOverride();
  program.configureOutput({
    outputError: (message, write) => write(message),
    writeErr: (message) => writeCommanderOutput(streams.stderr, message),
    writeOut: (message) => writeCommanderOutput(streams.stdout, message)
  });

  registerLifecycleCommands(program, handlers, streams);

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
  registerStatusCommand(program, handlers, streams, (exitCode) => {
    commandExitCode = exitCode;
  });
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
    return commandExitCode;
  } catch (error: unknown) {
    if (isCommanderError(error)) {
      // Commander prints its own usage message; usage errors exit 2.
      return error.exitCode === 0 ? 0 : 2;
    }

    streams.stderr(`error: ${formatCliErrorMessage(error)}`);
    // Usage/input errors exit 2; runtime failures exit 1, matching the
    // documented status exit-code contract across all commands.
    return cliErrorExitCode(error);
  }
};
