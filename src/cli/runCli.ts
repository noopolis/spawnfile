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
  addProjectModelFallback,
  addSubagentProject,
  addTeamProject,
  buildCompilePlan,
  buildProject,
  clearProjectModelFallbacks,
  compileProject,
  initProject,
  runProject,
  setProjectPrimaryModel,
  syncProjectAuth
} from "../compiler/index.js";
import { isSpawnfileError } from "../shared/index.js";
import { listRuntimeAdapters } from "../runtime/index.js";

export interface CliStreams {
  stderr: (message: string) => void;
  stdout: (message: string) => void;
}

const createDefaultStreams = (): CliStreams => ({
  stderr: (message) => process.stderr.write(`${message}\n`),
  stdout: (message) => process.stdout.write(`${message}\n`)
});

export interface CliHandlers {
  buildCompilePlan: typeof buildCompilePlan;
  buildProject: typeof buildProject;
  compileProject: typeof compileProject;
  addAgentProject: typeof addAgentProject;
  addProjectModelFallback: typeof addProjectModelFallback;
  addSubagentProject: typeof addSubagentProject;
  addTeamProject: typeof addTeamProject;
  clearProjectModelFallbacks: typeof clearProjectModelFallbacks;
  importClaudeCodeAuth: typeof importClaudeCodeAuth;
  importCodexAuth: typeof importCodexAuth;
  importEnvFile: typeof importEnvFile;
  initProject: typeof initProject;
  listRuntimeAdapters: typeof listRuntimeAdapters;
  requireAuthProfile: typeof requireAuthProfile;
  runProject: typeof runProject;
  setProjectPrimaryModel: typeof setProjectPrimaryModel;
  syncProjectAuth: typeof syncProjectAuth;
}

const createDefaultHandlers = (): CliHandlers => ({
  buildCompilePlan,
  buildProject,
  compileProject,
  addAgentProject,
  addProjectModelFallback,
  addSubagentProject,
  addTeamProject,
  clearProjectModelFallbacks,
  importClaudeCodeAuth,
  importCodexAuth,
  importEnvFile,
  initProject,
  listRuntimeAdapters,
  requireAuthProfile,
  runProject,
  setProjectPrimaryModel,
  syncProjectAuth
});

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

export const runCli = async (
  argv: string[],
  streams: CliStreams = createDefaultStreams(),
  handlerOverrides: Partial<CliHandlers> = {}
): Promise<number> => {
  const handlers = { ...createDefaultHandlers(), ...handlerOverrides };
  const program = new Command();
  program.name("spawnfile").description("Spawnfile v0.1 compiler");

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
    .option("-d, --detach", "Run the container in detached mode")
    .action(
      async (
        inputPath: string,
        options: {
          authProfile?: string;
          detach?: boolean;
          name?: string;
          out?: string;
          tag?: string;
        }
      ) => {
        const result = await handlers.runProject(inputPath, {
          authProfile: options.authProfile,
          containerName: options.name,
          detach: options.detach,
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
      for (const filePath of result.createdFiles) {
        streams.stdout(`created ${filePath}`);
      }
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
      for (const filePath of result.updatedFiles) {
        streams.stdout(`updated ${filePath}`);
      }
      for (const filePath of result.createdFiles) {
        streams.stdout(`created ${filePath}`);
      }
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
      for (const filePath of result.updatedFiles) {
        streams.stdout(`updated ${filePath}`);
      }
      for (const filePath of result.createdFiles) {
        streams.stdout(`created ${filePath}`);
      }
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
      for (const filePath of result.updatedFiles) {
        streams.stdout(`updated ${filePath}`);
      }
      for (const filePath of result.createdFiles) {
        streams.stdout(`created ${filePath}`);
      }
    });

  const modelCommand = program
    .command("model")
    .description("Edit primary and fallback model declarations");

  modelCommand
    .command("set")
    .argument("<provider>", "Model provider")
    .argument("<name>", "Model name")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("--auth <method>", "Model auth method")
    .option("--key <env>", "Environment variable for api_key auth")
    .option("--compat <compatibility>", "Endpoint compatibility for custom/local models")
    .option("--base-url <url>", "Endpoint base URL for custom/local models")
    .option("--recursive", "Update the target project and its descendants")
    .action(
      async (
        provider: string,
        name: string,
        inputPath: string,
        options: {
          auth?: "api_key" | "claude-code" | "codex" | "none";
          baseUrl?: string;
          compat?: "anthropic" | "openai";
          key?: string;
          recursive?: boolean;
        }
      ) => {
        const result = await handlers.setProjectPrimaryModel({
          authKey: options.key,
          authMethod: options.auth,
          endpointBaseUrl: options.baseUrl,
          endpointCompatibility: options.compat,
          name,
          path: inputPath,
          provider,
          recursive: options.recursive
        });

        for (const filePath of result.updatedFiles) {
          streams.stdout(`updated ${filePath}`);
        }
      }
    );

  modelCommand
    .command("add-fallback")
    .argument("<provider>", "Model provider")
    .argument("<name>", "Model name")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("--auth <method>", "Model auth method")
    .option("--key <env>", "Environment variable for api_key auth")
    .option("--compat <compatibility>", "Endpoint compatibility for custom/local models")
    .option("--base-url <url>", "Endpoint base URL for custom/local models")
    .option("--recursive", "Update the target project and its descendants")
    .action(
      async (
        provider: string,
        name: string,
        inputPath: string,
        options: {
          auth?: "api_key" | "claude-code" | "codex" | "none";
          baseUrl?: string;
          compat?: "anthropic" | "openai";
          key?: string;
          recursive?: boolean;
        }
      ) => {
        const result = await handlers.addProjectModelFallback({
          authKey: options.key,
          authMethod: options.auth,
          endpointBaseUrl: options.baseUrl,
          endpointCompatibility: options.compat,
          name,
          path: inputPath,
          provider,
          recursive: options.recursive
        });

        for (const filePath of result.updatedFiles) {
          streams.stdout(`updated ${filePath}`);
        }
      }
    );

  modelCommand
    .command("clear-fallbacks")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("--recursive", "Update the target project and its descendants")
    .action(async (inputPath: string, options: { recursive?: boolean }) => {
      const result = await handlers.clearProjectModelFallbacks({
        path: inputPath,
        recursive: options.recursive
      });

      for (const filePath of result.updatedFiles) {
        streams.stdout(`updated ${filePath}`);
      }
    });

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
      for (const line of formatAuthProfileSummary(profile)) {
        streams.stdout(line);
      }
    });

  authImportCommand
    .command("claude-code")
    .option("-p, --profile <name>", "Auth profile name", "default")
    .option("--from <directory>", "Source Claude Code config directory")
    .action(async (options: { from?: string; profile: string }) => {
      const profile = await handlers.importClaudeCodeAuth(options.profile, options.from);
      for (const line of formatAuthProfileSummary(profile)) {
        streams.stdout(line);
      }
    });

  authImportCommand
    .command("codex")
    .option("-p, --profile <name>", "Auth profile name", "default")
    .option("--from <directory>", "Source Codex config directory")
    .action(async (options: { from?: string; profile: string }) => {
      const profile = await handlers.importCodexAuth(options.profile, options.from);
      for (const line of formatAuthProfileSummary(profile)) {
        streams.stdout(line);
      }
    });

  authCommand
    .command("sync")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("-p, --profile <name>", "Auth profile name", "default")
    .option("--env-file <file>", "Path to an env file with model API keys")
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
        for (const line of formatAuthProfileSummary(profile)) {
          streams.stdout(line);
        }
      }
    );

  authCommand
    .command("show")
    .option("-p, --profile <name>", "Auth profile name", "default")
    .action(async (options: { profile: string }) => {
      const profile = await handlers.requireAuthProfile(options.profile);
      for (const line of formatAuthProfileSummary(profile)) {
        streams.stdout(line);
      }
    });

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error: unknown) {
    const message = isSpawnfileError(error)
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);

    streams.stderr(message);
    return 1;
  }
};
